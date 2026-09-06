export class StaleAgentTask extends Error {
  public constructor() { super('The notification task is no longer current'); }
}
