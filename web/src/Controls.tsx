import { NumberInput, NumberInputControl, NumberInputDecrement, NumberInputGroup, NumberInputIncrement } from "@ui-sdk/react/number-input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui-sdk/react/select"
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from "@ui-sdk/react/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip"
import { Minus, Plus } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { CATALOG, KINDS, type Kind } from "../../shared/catalog.ts"
import { KindIcon } from "./kinds.tsx"

export function Field({ label, value, hint, children }: { label: string; value?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-head">
        <span>{label}</span>
        {value !== undefined && <output>{value}</output>}
      </div>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )
}

export function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <NumberInput
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => {
        if (next !== null && Number.isFinite(next)) onChange(next)
      }}
    >
      <NumberInputGroup>
        <NumberInputDecrement aria-label={`Less ${label.toLowerCase()}`}>
          <Minus aria-hidden />
        </NumberInputDecrement>
        <NumberInputControl aria-label={label} />
        <NumberInputIncrement aria-label={`More ${label.toLowerCase()}`}>
          <Plus aria-hidden />
        </NumberInputIncrement>
      </NumberInputGroup>
    </NumberInput>
  )
}

export function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  onCommit?: (value: number) => void
}) {
  return (
    <Slider
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => onChange(next as number)}
      onValueCommit={(next) => onCommit?.(next as number)}
    >
      <SliderControl>
        <SliderTrack>
          <SliderIndicator />
          <SliderThumb aria-label={label} />
        </SliderTrack>
      </SliderControl>
    </Slider>
  )
}

export function KindSelect({ value, onChange, allowClient }: { value: Kind; onChange: (kind: Kind) => void; allowClient: boolean }) {
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next as Kind)}>
      <SelectTrigger aria-label="Kind of box">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {KINDS.filter((kind) => allowClient || kind !== "client" || kind === value).map((kind) => (
          <SelectItem key={kind} value={kind} label={CATALOG[kind].title}>
            <span className="kind-option">
              <KindIcon kind={kind} />
              {CATALOG[kind].title}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function Tip({ text, children }: { text: string; children: ReactElement<Record<string, unknown>> }) {
  return (
    <Tooltip delay={400}>
      <TooltipTrigger render={children} />
      <TooltipContent sideOffset={6}>{text}</TooltipContent>
    </Tooltip>
  )
}
