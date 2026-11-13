import type { Finding } from "./analyze.ts"
import type { Suggestion } from "./suggest.ts"

export type Step = {
  rate: number
  answered: number
  p95: number
  errorRate: number
  pass: boolean
  reason: string
}

export type RampResult = {
  capacity: number | null
  failedAt: number | null
  steps: Step[]
  finding: Finding | null
  suggestions: Suggestion[]
  probeLimited: boolean
  cancelled: boolean
}
