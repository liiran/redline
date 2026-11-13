import { z } from "zod"

// The page's security policy forbids eval, so zod is told not to try compiling validators.
z.config({ jitless: true })
