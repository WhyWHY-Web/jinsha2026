export function compactLabel(zoom:number, rank:number, overlaps:boolean, selected:boolean) {
  return zoom < 6.1 || (!selected && (rank >= 25 || overlaps))
}
