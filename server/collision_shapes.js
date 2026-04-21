// Config de shapes de colisión de la mesa.
// Regenerado desde shape_editor.html (herramienta de autoría visual).
// Para actualizar: abrir shape_editor.html → configurar → Export → reemplazar el contenido de este archivo.

const COLLISION_SHAPES = [
  { id: 8, label: "pocket_8", type: "pocket", cx: 31, cy: 30, rx: 27, ry: 27 },
  { id: 10, label: "pocket_10", type: "pocket", cx: 450, cy: 17, rx: 22, ry: 22 },
  { id: 11, label: "pocket_11", type: "pocket", cx: 869, cy: 30, rx: 27, ry: 27 },
  { id: 12, label: "pocket_12", type: "pocket", cx: 31, cy: 469, rx: 27, ry: 26 },
  { id: 13, label: "pocket_13", type: "pocket", cx: 450, cy: 483, rx: 22, ry: 22 },
  { id: 14, label: "pocket_14", type: "pocket", cx: 869, cy: 469, rx: 27, ry: 26 },
  { id: 18, label: "shape_18", type: "rail", x: 59, y: 4, w: 369, h: 40, cutTL: 10, cutTR: 10, cutBL: 21, cutBR: 15, angleTL: 45, angleTR: 45, angleBL: 45, angleBR: 17 },
  { id: 19, label: "shape_19", type: "rail", x: 472, y: 1, w: 370, h: 43, cutTL: 10, cutTR: 10, cutBL: 15, cutBR: 21, angleTL: 45, angleTR: 45, angleBL: 17, angleBR: 45 },
  { id: 20, label: "shape_20", type: "rail", x: 854, y: 57, w: 47, h: 386, cutTL: 38, cutTR: 10, cutBL: 21, cutBR: 10, angleTL: 45, angleTR: 45, angleBL: 45, angleBR: 45 },
  { id: 21, label: "shape_21", type: "rail", x: -7, y: 57, w: 52, h: 386, cutTL: 10, cutTR: 21, cutBL: 10, cutBR: 21, angleTL: 45, angleTR: 45, angleBL: 45, angleBR: 45 },
  { id: 22, label: "shape_22", type: "rail", x: 58, y: 454, w: 371, h: 47, cutTL: 47, cutTR: 15, cutBL: 10, cutBR: 10, angleTL: 45, angleTR: 17, angleBL: 45, angleBR: 45 },
  { id: 23, label: "shape_23", type: "rail", x: 471, y: 454, w: 370, h: 44, cutTL: 15, cutTR: 21, cutBL: 10, cutBR: 10, angleTL: 17, angleTR: 45, angleBL: 45, angleBR: 45 },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COLLISION_SHAPES };
} else {
  window.COLLISION_SHAPES = COLLISION_SHAPES;
}
