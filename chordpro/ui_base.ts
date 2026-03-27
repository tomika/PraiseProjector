export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rectangle = Point & Size;

export type NoteHitBox = Rectangle & { note: number; param?: number };
