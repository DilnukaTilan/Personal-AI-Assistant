import { Daytona } from '@daytona/sdk'

async function main() {
  if (!process.env.DAYTONA_API_KEY?.trim()) {
    throw new Error(
      'Set DAYTONA_API_KEY in your shell or .env before running this script. ' +
      'Create a key at https://app.daytona.io/dashboard/keys.'
    )
  }

  const daytona = new Daytona()
  const sandbox = await daytona.v0.create(
    {
      language: 'typescript',
      // Fall back to automatic cleanup if this process is interrupted.
      ephemeral: true,
      autoStopInterval: 5,
    },
    { timeout: 60 }
  )
  console.log(`Created sandbox: ${sandbox.id}`)

  try {
    const response = await sandbox.process.codeRun(
      'console.log("Hello World")',
      undefined,
      30
    )
    const output = response.result.trim()
    console.log(output)

    if (response.exitCode !== 0 || output !== 'Hello World') {
      throw new Error(`Hello World verification failed (exit code ${response.exitCode}).`)
    }
  } finally {
    // Wait for destruction before reporting successful cleanup.
    await daytona.v0.delete(sandbox, 60, true)
    console.log(`Deleted sandbox: ${sandbox.id}`)
  }

  console.log('Daytona smoke test passed.')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown Daytona error'
  const apiKey = process.env.DAYTONA_API_KEY
  console.error(apiKey ? message.replaceAll(apiKey, '[REDACTED]') : message)
  process.exitCode = 1
})
