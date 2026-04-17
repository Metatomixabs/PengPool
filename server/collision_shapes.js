// Config de shapes de colisión de la mesa.
// Regenerado desde shape_editor.html (herramienta de autoría visual).
// Para actualizar: abrir shape_editor.html → configurar → Export → reemplazar el contenido de este archivo.

const COLLISION_SHAPES = [
  { id: 2,  label: "shape_2",   type: "rail",   x: 78,  y: 26,  w: 301, h: 49, cut: 12 },
  { id: 3,  label: "shape_3",   type: "rail",   x: 416, y: 26,  w: 304, h: 50, cut: 12 },
  { id: 4,  label: "shape_4",   type: "rail",   x: 75,  y: 439, w: 303, h: 51, cut: 12 },
  { id: 5,  label: "shape_5",   type: "rail",   x: 415, y: 440, w: 307, h: 52, cut: 12 },
  { id: 6,  label: "shape_6",   type: "rail",   x: 14,  y: 91,  w: 48,  h: 333, cut: 13 },
  { id: 7,  label: "shape_7",   type: "rail",   x: 738, y: 90,  w: 55,  h: 337, cut: 14 },
  { id: 8,  label: "pocket_8",  type: "pocket", cx: 40,  cy: 56,  rx: 37, ry: 35 },
  { id: 10, label: "pocket_10", type: "pocket", cx: 398, cy: 46,  rx: 17, ry: 31 },
  { id: 11, label: "pocket_11", type: "pocket", cx: 757, cy: 56,  rx: 36, ry: 34 },
  { id: 12, label: "pocket_12", type: "pocket", cx: 33,  cy: 465, rx: 42, ry: 41 },
  { id: 13, label: "pocket_13", type: "pocket", cx: 397, cy: 473, rx: 17, ry: 33 },
  { id: 14, label: "pocket_14", type: "pocket", cx: 760, cy: 465, rx: 39, ry: 38 },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COLLISION_SHAPES };
} else {
  window.COLLISION_SHAPES = COLLISION_SHAPES;
}
