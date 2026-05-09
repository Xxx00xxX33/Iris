import { useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { InputDisplay } from "../components/InputDisplay.js"
import { useCursorBlink } from "../hooks/use-cursor-blink.js"
import { usePaste } from "../hooks/use-paste.js"
import {
  applyTextInputKey,
  insertTextInputValue,
  isTextInputKeyHandled,
  type TextInputState,
} from "../hooks/use-text-input.js"
import { gracefulExit } from "../runtime.js"
import { PageFrame } from "./PageFrame.js"

export interface ScrollableInputFieldDefinition {
  key: string
  label: string
  description?: string
  placeholder?: string
  defaultValue?: string
  required?: boolean
  masked?: boolean
  validate?: (value: string, values: Record<string, string>) => string | undefined
  normalizePastedText?: (text: string) => string
}

interface ScrollableInputPageProps {
  title: string
  description?: string
  fields: ScrollableInputFieldDefinition[]
  onSubmit: (values: Record<string, string>) => void
  onSkip?: () => void
  onBack?: () => void
  maxVisibleFields?: number
}

function maskValue(value: string): string {
  return value.length === 0 ? "" : value.slice(0, 4) + "•".repeat(Math.max(0, value.length - 4))
}

function buildInitialFieldStates(fields: ScrollableInputFieldDefinition[]): Record<string, TextInputState> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = field.defaultValue ?? ""
      return [field.key, { value, cursor: value.length } satisfies TextInputState]
    }),
  )
}

function getFieldValues(fieldStates: Record<string, TextInputState>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fieldStates).map(([key, state]) => [key, state.value]),
  )
}

function computeFieldError(
  field: ScrollableInputFieldDefinition,
  values: Record<string, string>,
): string | undefined {
  const value = values[field.key] ?? ""
  if (field.required && value.trim().length === 0) {
    return `请填写 ${field.label}`
  }
  return field.validate?.(value, values)
}

export function ScrollableInputPage({
  title,
  description,
  fields,
  onSubmit,
  onSkip,
  onBack,
  maxVisibleFields = 4,
}: ScrollableInputPageProps) {
  const [fieldStates, setFieldStates] = useState<Record<string, TextInputState>>(() => buildInitialFieldStates(fields))
  const [activeIndex, setActiveIndex] = useState(0)
  const [showMaskedFields, setShowMaskedFields] = useState(false)
  const cursorVisible = useCursorBlink()

  const activeField = fields[Math.min(activeIndex, Math.max(0, fields.length - 1))]
  const values = useMemo(() => getFieldValues(fieldStates), [fieldStates])
  const errors = useMemo(() => {
    return Object.fromEntries(
      fields.map((field) => [field.key, computeFieldError(field, values)]),
    ) as Record<string, string | undefined>
  }, [fields, values])

  const hasMaskedField = fields.some((field) => field.masked)
  const canSubmit = fields.length > 0 && fields.every((field) => !errors[field.key])

  let scrollStart = 0
  if (fields.length > maxVisibleFields) {
    scrollStart = Math.max(0, Math.min(activeIndex - Math.floor(maxVisibleFields / 2), fields.length - maxVisibleFields))
  }
  const visibleFields = fields.slice(scrollStart, scrollStart + maxVisibleFields)

  useKeyboard((key) => {
    if (key.name === "n" && key.ctrl) {
      onSkip?.()
      return
    }

    if (key.name === "escape") {
      onBack?.()
      return
    }

    if (key.name === "c" && key.ctrl) {
      gracefulExit()
      return
    }

    if (hasMaskedField && key.name === "h" && key.ctrl) {
      key.preventDefault()
      setShowMaskedFields((value) => !value)
      return
    }

    if (key.name === "tab" || key.name === "down") {
      setActiveIndex((index) => Math.min(fields.length - 1, index + 1))
      return
    }

    if (key.name === "up") {
      setActiveIndex((index) => Math.max(0, index - 1))
      return
    }

    if (key.name === "return") {
      if (canSubmit) {
        onSubmit(values)
      }
      return
    }

    if (!activeField) return

    if (isTextInputKeyHandled(key)) {
      key.preventDefault()
      setFieldStates((current) => ({
        ...current,
        [activeField.key]: applyTextInputKey(current[activeField.key], key),
      }))
    }
  })

  usePaste((text) => {
    if (!activeField) return

    const cleaned = text.replace(/[\r\n]/g, "").trim()
    if (!cleaned) return

    const normalized = activeField.normalizePastedText?.(cleaned) ?? cleaned
    if (!normalized) return

    setFieldStates((current) => ({
      ...current,
      [activeField.key]: insertTextInputValue(current[activeField.key], normalized),
    }))
  })

  return (
    <PageFrame
      title={title}
      description={description}
      actions={[
        "↑↓ 切换字段",
        hasMaskedField ? "Ctrl+H 显示/隐藏敏感字段" : undefined,
        "Enter 确认",
        onSkip ? "Ctrl+N 跳过此环节" : undefined,
        onBack ? "Esc 返回" : undefined,
      ]}
    >
      <box flexDirection="column" gap={1}>
        {scrollStart > 0 && (
          <text fg="#636e72">{`↑ 上方还有 ${scrollStart} 项`}</text>
        )}

        {visibleFields.map((field, index) => {
          const realIndex = scrollStart + index
          const isActive = realIndex === activeIndex
          const fieldState = fieldStates[field.key]
          const error = errors[field.key]

          return (
            <box key={field.key} flexDirection="column" gap={0}>
              <text>
                <span fg={isActive ? "#00b894" : "#636e72"}>{isActive ? "❯ " : "  "}</span>
                <span fg="#dfe6e9">{field.label}</span>
                {field.required && <span fg="#fdcb6e">{" *"}</span>}
              </text>
              {field.description && (
                <text fg="#636e72">{`  ${field.description}`}</text>
              )}
              <box
                borderStyle="single"
                borderColor={isActive ? "#00b894" : fieldState.value.length > 0 ? "#6c5ce7" : "#636e72"}
                paddingLeft={1}
                paddingRight={1}
                marginLeft={2}
              >
                <InputDisplay
                  value={fieldState.value}
                  cursor={fieldState.cursor}
                  isActive={isActive}
                  cursorVisible={cursorVisible}
                  placeholder={field.placeholder}
                  transform={field.masked && !showMaskedFields ? maskValue : undefined}
                />
              </box>
              {error && <text fg="#ff7675">{`  ${error}`}</text>}
            </box>
          )
        })}

        {scrollStart + maxVisibleFields < fields.length && (
          <text fg="#636e72">{`↓ 下方还有 ${fields.length - scrollStart - maxVisibleFields} 项`}</text>
        )}
      </box>
    </PageFrame>
  )
}
