// @module tooling.architecture
// @role graph
/** Strongly connected components, with edge evidence retained by the caller. */
export function cycles(edges) {
  const adjacency = new Map();
  for (const {from, to} of edges) {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    if (!adjacency.has(to)) adjacency.set(to, new Set());
    adjacency.get(from).add(to);
  }
  let next = 0;
  const index = new Map(), low = new Map(), stack = [], active = new Set(), result = [];
  function visit(node) {
    index.set(node, next); low.set(node, next++); stack.push(node); active.add(node);
    for (const target of adjacency.get(node)) {
      if (!index.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))); }
      else if (active.has(target)) low.set(node, Math.min(low.get(node), index.get(target)));
    }
    if (low.get(node) !== index.get(node)) return;
    const component = []; let item;
    do { item = stack.pop(); active.delete(item); component.push(item); } while (item !== node);
    if (component.length > 1 || adjacency.get(node).has(node)) result.push(component.sort());
  }
  for (const node of adjacency.keys()) if (!index.has(node)) visit(node);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}
