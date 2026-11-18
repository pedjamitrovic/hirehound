// Errors raised while turning an uploaded file into text. The message is shown in the UI as is,
// so it is one or two short sentences that say what happened and what to do next.

export type ImportErrorCode =
  | "unsupported-type"
  | "too-large"
  | "corrupt"
  | "encrypted"
  | "zip64"
  | "empty";

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}
