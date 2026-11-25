import { logger, task } from "@trigger.dev/sdk";
export const helloWorld = task({
    id: "hello-world",
    run: async (payload) => {
        const message = `Hello ${payload.name ?? "world"}!`;
        logger.info(message);
        return {
            message,
            timestamp: new Date().toISOString(),
        };
    },
});
