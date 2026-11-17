// Test-only, layout-independent inspection of live V8 event envelopes.
// getHeapSnapshot performs GC. Fixture inputs must leave scope first; retain the
// candidate store across this call, and never retain candidate events() results.
import { getHeapSnapshot } from "node:v8";

interface Snapshot {
  snapshot: { meta: { node_fields: string[]; node_types: (string[] | string)[]; edge_fields: string[]; edge_types: (string[] | string)[] } };
  nodes: number[]; edges: number[]; strings: string[];
}
export interface Inventory {
  pinned: { objects: number; jsonBytes: number; shallowBytes: number };
  recent: { objects: number; jsonBytes: number; shallowBytes: number; ids: string[] };
  auxiliary: { eventLikeNonEnvelopeObjects: number; shallowBytes: number; exclusiveRetainedBytes: number | null };
  exclusiveStoreBytes: number | null;
}
export function storageGate(inventory: Inventory, count: number, budget: number): void {
  if (inventory.recent.objects > count || inventory.recent.jsonBytes > budget) {
    throw new Error(`raw recent retention exceeds budget: objects=${inventory.recent.objects}/${count}, bytes=${inventory.recent.jsonBytes}/${budget}`);
  }
}

export async function retainedEnvelopes(room: string, sizes: ReadonlyMap<string, number>): Promise<Inventory> {
  const chunks: Buffer[] = [];
  for await (const chunk of getHeapSnapshot({ exposeNumericValues: true })) chunks.push(Buffer.from(chunk as Uint8Array));
  const heap = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Snapshot;
  chunks.length = 0;
  const nf = heap.snapshot.meta.node_fields; const ef = heap.snapshot.meta.edge_fields;
  const stride = nf.length; const edgeStride = ef.length;
  const nameIndex = nf.indexOf("name"), typeIndex = nf.indexOf("type"), sizeIndex = nf.indexOf("self_size"), countIndex = nf.indexOf("edge_count");
  const edgeNameIndex = ef.indexOf("name_or_index"), targetIndex = ef.indexOf("to_node"), edgeTypeIndex = ef.indexOf("type");
  const nodeTypes = heap.snapshot.meta.node_types[typeIndex] as string[];
  const edgeTypes = heap.snapshot.meta.edge_types[edgeTypeIndex] as string[];
  const starts = new Map<number, number>();
  let edge = 0;
  for (let node = 0; node < heap.nodes.length; node += stride) {
    starts.set(node, edge); edge += heap.nodes[node + countIndex]! * edgeStride;
  }
  function properties(node: number): Map<string, number> {
    const props = new Map<string, number>(); const start = starts.get(node)!;
    const end = start + heap.nodes[node + countIndex]! * edgeStride;
    for (let e = start; e < end; e += edgeStride) {
      if (edgeTypes[heap.edges[e + edgeTypeIndex]!] === "property") {
        props.set(heap.strings[heap.edges[e + edgeNameIndex]!]!, heap.edges[e + targetIndex]!);
      }
    }
    return props;
  }
  function stringValue(node: number | undefined): string | undefined {
    if (node === undefined) return undefined;
    const kind = nodeTypes[heap.nodes[node + typeIndex]!];
    if (kind === "string") return heap.strings[heap.nodes[node + nameIndex]!];
    if (kind === "concatenated string") {
      const start = starts.get(node)!; const parts: string[] = [];
      for (let e = start; e < start + heap.nodes[node + countIndex]! * edgeStride; e += edgeStride) {
        const name = heap.strings[heap.edges[e + edgeNameIndex]!];
        if (name === "first" || name === "second") parts.push(stringValue(heap.edges[e + targetIndex]!) ?? "");
      }
      return parts.join("");
    }
    return undefined;
  }
  const result: Inventory = { pinned: { objects: 0, jsonBytes: 0, shallowBytes: 0 },
    recent: { objects: 0, jsonBytes: 0, shallowBytes: 0, ids: [] },
    auxiliary: { eventLikeNonEnvelopeObjects: 0, shallowBytes: 0, exclusiveRetainedBytes: null }, exclusiveStoreBytes: null };
  let root: number | undefined;
  const envelopeRoots: number[] = [];
  for (let node = 0; node < heap.nodes.length; node += stride) {
    if (nodeTypes[heap.nodes[node + typeIndex]!] !== "object") continue;
    const props = properties(node);
    if (stringValue(props.get("__u123HeapRoot")) === room) root = props.get("candidate") ?? node;
    if (stringValue(props.get("room")) !== room) continue;
    const eventId = stringValue(props.get("id"));
    if (eventId === undefined || !sizes.has(eventId)) continue;
    const shallowBytes = heap.nodes[node + sizeIndex]!;
    if (!["agent", "act", "text"].every(key => props.has(key))) {
      result.auxiliary.eventLikeNonEnvelopeObjects++; result.auxiliary.shallowBytes += shallowBytes; continue;
    }
    const act = stringValue(props.get("act"));
    const opNode = props.get("op");
    const kind = opNode === undefined ? undefined : stringValue(properties(opNode).get("kind"));
    const isPinned = act === "op" && kind !== "activity.beat";
    envelopeRoots.push(node);
    const category = isPinned ? result.pinned : result.recent;
    category.objects++; category.jsonBytes += sizes.get(eventId)!; category.shallowBytes += shallowBytes;
    if (!isPinned) result.recent.ids.push(eventId);
  }
  if (root !== undefined) {
    // A node is exclusively retained by the marked store when removing the
    // store disconnects it from the GC root. Shared objects are excluded.
    const reach = (blocked?: number): Uint8Array => {
      const visited = new Uint8Array(heap.nodes.length / stride);
      const queue: number[] = [0]; visited[0] = 1;
      for (let q = 0; q < queue.length; q++) {
        const node = queue[q]!; const start = starts.get(node)!;
        for (let e = start; e < start + heap.nodes[node + countIndex]! * edgeStride; e += edgeStride) {
          if (edgeTypes[heap.edges[e + edgeTypeIndex]!] === "weak") continue;
          const target = heap.edges[e + targetIndex]!;
          if (target === blocked || visited[target / stride]) continue;
          visited[target / stride] = 1; queue.push(target);
        }
      }
      return visited;
    };
    const all = reach(); const withoutStore = reach(root);
    const exclusive = (node: number): boolean => all[node / stride] === 1 && withoutStore[node / stride] === 0;
    let total = 0;
    for (let node = 0; node < heap.nodes.length; node += stride) if (exclusive(node)) total += heap.nodes[node + sizeIndex]!;
    const payloads = new Set<number>(); const queue = envelopeRoots.filter(exclusive);
    for (let q = 0; q < queue.length; q++) {
      const node = queue[q]!; if (payloads.has(node)) continue; payloads.add(node);
      const start = starts.get(node)!;
      for (let e = start; e < start + heap.nodes[node + countIndex]! * edgeStride; e += edgeStride) {
        if (edgeTypes[heap.edges[e + edgeTypeIndex]!] === "weak") continue;
        const target = heap.edges[e + targetIndex]!; if (exclusive(target) && !payloads.has(target)) queue.push(target);
      }
    }
    let payloadBytes = 0; for (const node of payloads) payloadBytes += heap.nodes[node + sizeIndex]!;
    result.exclusiveStoreBytes = total;
    result.auxiliary.exclusiveRetainedBytes = total - payloadBytes;
  }
  result.recent.ids.sort(); return result;
}
