import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver/node";
import type { Message } from "./protocol.js";

export { StreamMessageReader, StreamMessageWriter };

export class MessageReader extends EventEmitter {
  private readonly reader: StreamMessageReader;
  private isDisposed = false;

  constructor(readable: Readable) {
    super();
    this.reader = new StreamMessageReader(readable);
    this.reader.listen((message) => {
      if (!this.isDisposed) {
        this.emit("message", message);
      }
    });
    this.reader.onError((err) => {
      this.emit("error", err);
    });
    this.reader.onClose(() => {
      if (!this.isDisposed) {
        this.emit("close");
      }
    });
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.reader.dispose();
    this.removeAllListeners();
  }
}

export class MessageWriter {
  private readonly writer: StreamMessageWriter;
  private isDisposed = false;

  constructor(writable: Writable) {
    this.writer = new StreamMessageWriter(writable);
  }

  public write(message: Message): boolean {
    if (this.isDisposed) return false;
    this.writer.write(message);
    return true;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.writer.dispose();
  }
}

export function formatLspMessage(message: Message): string {
  const json = JSON.stringify(message);
  const byteLength = Buffer.byteLength(json, "utf-8");
  return `Content-Length: ${byteLength}\r\n\r\n${json}`;
}
