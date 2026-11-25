// Runs only inside the disposable sandbox. Uploaded documents are data, never scripts.
export const parseUploadedFile = String.raw `
import base64, io, json, pathlib, sys, zipfile

path = pathlib.Path(sys.argv[1])
start = int(sys.argv[2]) - 1
limit = 30000
suffix = path.suffix.lower()
text = ''
note = ''
image = None
if suffix in ('.docx', '.xlsx'):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(e.file_size for e in entries) > 100 * 1024 * 1024:
            raise ValueError('Expanded document exceeds parser limits')
if suffix == '.pdf':
    import fitz
    with fitz.open(path) as doc:
        if doc.needs_pass:
            raise ValueError('Password-protected PDF; request an unlocked copy')
        if start >= len(doc):
            raise ValueError('Requested page is outside the document')
        end = min(start + 5, len(doc))
        pages = [doc[i].get_text()[:limit] for i in range(start, end)]
        text = '\n'.join('[Page ' + str(start + i + 1) + ']\n' + content for i, content in enumerate(pages))
        note = f'Pages {start + 1}-{end} of {len(doc)}. Other pages were not read.'
        if not any(content.strip() for content in pages):
            from PIL import Image
            pix = doc[start].get_pixmap(matrix=fitz.Matrix(1, 1))
            image = Image.open(io.BytesIO(pix.tobytes('png')))
            note += ' No embedded text; image preview of the first requested page only.'
elif suffix == '.docx':
    from docx import Document
    doc = Document(path)
    pieces = []
    size = 0
    for item in list(doc.paragraphs) + [p for table in doc.tables for row in table.rows for cell in row.cells for p in cell.paragraphs]:
        pieces.append(item.text)
        size += len(item.text)
        if size > limit:
            break
    text = '\n'.join(pieces)
    note = 'Body paragraphs and tables only; headers, footers, comments, and embedded objects are not included.'
elif suffix == '.xlsx':
    from openpyxl import load_workbook
    book = load_workbook(path, read_only=True, data_only=False, keep_links=False)
    pieces = []
    try:
        for sheet in book.worksheets[:5]:
            pieces.append('[Sheet ' + sheet.title + ']')
            for row in sheet.iter_rows(min_row=start + 1, max_row=start + 200, max_col=30, values_only=True):
                pieces.append('\t'.join('' if v is None else str(v) for v in row))
                if sum(map(len, pieces)) > limit:
                    break
    finally:
        book.close()
    text = '\n'.join(pieces)
    note = 'At most 5 sheets, 200 rows per sheet, 30 columns. Formulas are text and are never executed.'
elif suffix in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 25000000
    image = Image.open(path)
    note = 'Image preview; animated/multipage images show the first frame only.'
elif suffix in ('.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.log', '.yaml', '.yml', '.py', '.js', '.ts'):
    with path.open('rb') as file:
        text = file.read(limit * 4 + 1).decode('utf-8', errors='replace')
    note = 'UTF-8 text preview only; markup and code are never executed.'
else:
    note = 'No built-in parser for this type. The original file is available for sandbox tools; do not claim its contents were read.'
result = {'text': text[:limit], 'truncated': len(text) > limit, 'note': note}
if image is not None:
    from PIL import ImageOps
    image = ImageOps.exif_transpose(image).convert('RGB')
    image.thumbnail((1400, 1400))
    for quality in (80, 55, 30):
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=quality)
        if output.tell() <= 450000:
            break
    if output.tell() > 450000:
        raise ValueError('Preview exceeds image limits')
    result['imageBase64'] = base64.b64encode(output.getvalue()).decode('ascii')
    result['mediaType'] = 'image/jpeg'
print(json.dumps(result))
`;
