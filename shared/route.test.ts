import { describe, expect, it } from "vitest"
import { NODE_HEIGHT, NODE_WIDTH, layout } from "./normalize.ts"
import { arrowBetween, crosses, route, type Rect } from "./route.ts"
import { TEMPLATES } from "./templates.ts"

const rect = (x: number, y: number): Rect => ({ x, y, w: NODE_WIDTH, h: NODE_HEIGHT })

describe("routing arrows", () => {
  it("draws a plain curve when nothing is in the way", () => {
    expect(route({ x: 0, y: 0 }, { x: 300, y: 80 }, [rect(100, 300)])).toHaveLength(2)
  })

  it("goes round a box sitting on the straight line", () => {
    const blocker = rect(150, -30)
    const points = route({ x: 0, y: 0 }, { x: 500, y: 0 }, [blocker])
    expect(points.length).toBeGreaterThan(2)
    expect(crosses(points, blocker)).toBe(false)
  })

  it("threads between two boxes in the same column", () => {
    const above = rect(150, -100)
    const below = rect(150, 30)
    const points = route({ x: 0, y: 0 }, { x: 500, y: 0 }, [above, below])
    expect(crosses(points, above) || crosses(points, below)).toBe(false)
  })

  it.each(TEMPLATES.map((t) => [t.name, t.design] as const))("%s: every arrow runs left to right and misses every box", (_, design) => {
    const laid = layout(design)
    const boxes = new Map(laid.nodes.map((n) => [n.id, rect(n.x, n.y)]))
    for (const edge of laid.edges) {
      const others = [...boxes.entries()].filter(([id]) => id !== edge.from && id !== edge.to).map(([, box]) => box)
      const arrow = arrowBetween(boxes.get(edge.from)!, boxes.get(edge.to)!, others)
      expect(arrow, `${edge.id} should run left to right`).not.toBeNull()
      for (const box of others) expect(crosses(arrow!.points, box), `${edge.id} runs through a box`).toBe(false)
    }
  })
})
