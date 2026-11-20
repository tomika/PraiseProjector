// Vite's `?raw` imports for the main-process build (tsconfig.node.json does not load vite/client).
declare module "*?raw" {
  const content: string;
  export default content;
}
