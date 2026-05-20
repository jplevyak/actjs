/**
 * SWM fixture for codegen tests. Two handlers, structural arg/return
 * types — the kinds we expect to survive extraction cleanly.
 */
class Cart extends actjs.Actor<{ items: { sku: string; qty: number }[] }> {
  @handler('addItem')
  addItem(args: { sku: string; qty: number }): { total: number } {
    this.state.items.push(args);
    return { total: this.state.items.length };
  }

  @handler('clear')
  clear(_args: Record<string, never>): void {
    this.state.items = [];
  }
}
