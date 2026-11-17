// A refusal with a machine code. Every surface (REST, MCP) maps `code` onto its own wire shape.
export class CodedError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
