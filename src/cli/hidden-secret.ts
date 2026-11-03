import type { ReadStream, WriteStream } from "node:tty";

/**
 * Read a terminal secret without echoing characters. Non-interactive callers
 * must provide credentials through the environment instead of stdin.
 */
export async function readHiddenSecret(
  input: ReadStream,
  output: WriteStream,
  prompt: string,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Secure interactive API-key entry requires a TTY. Set the provider API key in the environment instead.");
  }

  output.write(prompt);
  input.setRawMode(true);
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      const data = chunk.toString("utf8");
      for (const character of data) {
        if (character === "\u0003") {
          finish(new Error("API-key entry cancelled."));
          return;
        }
        if (character === "\u0004") {
          finish(new Error("API-key entry ended before completion."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}
