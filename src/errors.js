export class WorkslotError extends Error {
  constructor(message, status = 1) {
    super(message);
    this.name = "WorkslotError";
    this.status = status;
  }
}
