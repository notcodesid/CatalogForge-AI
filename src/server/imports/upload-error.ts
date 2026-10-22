// A problem with what the client sent. The message is shown to the merchant as is
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
