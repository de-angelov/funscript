export interface Logger {
  info(message: string, ...args: unknown[]): void;
  info(object: object, message?: string, ...args: unknown[]): void;
}
export declare const logger: Logger;
