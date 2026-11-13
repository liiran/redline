import { describe, expect, it } from "vitest"
import { parseDockerHost } from "./docker.ts"
import { fromWire, pickReader, toDesign, WIRE_SCHEMA } from "./recognize.ts"

describe("reading Claude's answer", () => {
  const wire = {
    nodes: [
      { ref: "n1", label: "Users", kind: "client", box: { x: 10, y: 10, w: 100, h: 60 }, replicas: null },
      { ref: "n2", label: "API", kind: "service", box: { x: 200, y: 10, w: 100, h: 60 }, replicas: 3.4 },
      { ref: "n3", label: "Postgres", kind: "database", box: { x: 400, y: 10, w: 100, h: 60 }, replicas: null },
    ],
    edges: [
      { from: "n1", to: "n2" },
      { from: "n3", to: "n2" },
    ],
  }

  it("turns boxes into the sketch shape and rounds counts", () => {
    const sketch = fromWire(wire)
    expect(sketch.nodes[0]!.box).toEqual([10, 10, 100, 60])
    expect(sketch.nodes[1]!.replicas).toBe(3)
  })

  it("rejects kinds it doesn't know", () => {
    expect(() => fromWire({ nodes: [{ ref: "a", label: "x", kind: "spaceship", box: { x: 0, y: 0, w: 1, h: 1 }, replicas: null }], edges: [] })).toThrow()
  })

  it("keeps the photo's coordinates for a photo, and lays out a description", () => {
    const sketch = fromWire(wire)
    const fromPhoto = toDesign(sketch, { image: { data: "x", mediaType: "image/png", width: 600, height: 100 } }, "0123456789abcdef").design
    expect(fromPhoto.photo).toEqual({ id: "0123456789abcdef", width: 600, height: 100 })
    expect(fromPhoto.edges.map((e) => e.id)).toEqual(["users->api", "api->postgres"])
    expect(fromPhoto.name).toBe("Whiteboard sketch")
    const fromText = toDesign(sketch, { text: "users, api, postgres" }).design
    expect(fromText.photo).toBeUndefined()
    expect(fromText.nodes.find((n) => n.id === "postgres")!.x).toBeGreaterThan(fromText.nodes.find((n) => n.id === "api")!.x)
  })

  it("uses Claude's short title for the design, and says how many arrows it had to add", () => {
    const named = fromWire({
      ...wire,
      name: "game backend",
      nodes: [...wire.nodes, { ref: "n4", label: "Assets CDN", kind: "cdn", box: { x: 0, y: 0, w: 0, h: 0 }, replicas: null }],
    })
    const { design, added } = toDesign(named, { text: "a game" })
    expect(design.name).toBe("Game backend")
    expect(added).toBe(2)
  })

  it("sends a schema structured outputs accept: closed objects, no number or length limits", () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return
      const o = node as Record<string, unknown>
      if (o.type === "object") expect(o.additionalProperties).toBe(false)
      for (const banned of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) expect(o[banned]).toBeUndefined()
      for (const value of Object.values(o)) walk(value)
    }
    walk(WIRE_SCHEMA)
  })
})

describe("choosing how to read drawings", () => {
  it("can be turned off, and needs a key for the API", () => {
    expect(pickReader({ REDLINE_AI: "off" })).toBeNull()
    expect(pickReader({ REDLINE_AI: "api" })).toBeNull()
    expect(pickReader({ REDLINE_AI: "api", ANTHROPIC_API_KEY: "sk-test" })?.name).toBe("api")
    expect(pickReader({ REDLINE_AI: "cli", PATH: "" })).toBeNull()
    expect(pickReader({ REDLINE_AI: "cli", REDLINE_CLAUDE_BIN: "/opt/claude" })?.name).toBe("cli")
  })

  it("prefers the signed-in CLI, and falls back to the API key", () => {
    expect(pickReader({ PATH: "", REDLINE_CLAUDE_BIN: "/opt/claude", ANTHROPIC_API_KEY: "sk-test" })?.name).toBe("cli")
    expect(pickReader({ PATH: "", ANTHROPIC_API_KEY: "sk-test" })?.name).toBe("api")
  })
})

describe("finding Docker", () => {
  it("understands Windows pipes, Unix sockets and TCP", () => {
    expect(parseDockerHost("npipe:////./pipe/dockerDesktopLinuxEngine")).toEqual({ socketPath: "\\\\.\\pipe\\dockerDesktopLinuxEngine" })
    expect(parseDockerHost("unix:///var/run/docker.sock")).toEqual({ socketPath: "/var/run/docker.sock" })
    expect(parseDockerHost("tcp://10.0.0.5:2375")).toEqual({ host: "10.0.0.5", port: 2375 })
    expect(() => parseDockerHost("ssh://box")).toThrow()
  })
})
