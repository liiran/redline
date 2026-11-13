import { Cloud, Cog, Database, Globe, Layers, Server, Split, Users, Zap, type LucideIcon } from "lucide-react"
import type { Kind } from "../../shared/catalog.ts"

export const KIND_ICON: Record<Kind, LucideIcon> = {
  client: Users,
  cdn: Globe,
  loadbalancer: Split,
  service: Server,
  worker: Cog,
  queue: Layers,
  cache: Zap,
  database: Database,
  external: Cloud,
}

export function KindIcon({ kind }: { kind: Kind }) {
  const Icon = KIND_ICON[kind]
  return <Icon aria-hidden strokeWidth={1.75} />
}
