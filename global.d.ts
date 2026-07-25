/// <reference types="bun-types/test-globals" />

declare module '*.md' {
  const content: string;
  export default content;
}
