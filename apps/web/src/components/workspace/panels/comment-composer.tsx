'use client'

import { COMMENT_BODY_MAX_LENGTH, commentRateLimitedErrorSchema } from '@kaxolax/contracts'
import { Button, cn, Spinner } from '@kaxolax/ui'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '@/lib/api'
import {
  type ChatMember,
  encodeMentions,
  insertMention,
  mentionQueryAt,
  mentionSuggestions,
  type PickedMention,
} from '@/lib/chat'
import { commentErrorMessage } from '@/lib/comments'

function submitError(caught: unknown): string {
  if (caught instanceof ApiError && caught.status === 429) {
    const body = commentRateLimitedErrorSchema.safeParse(caught.body)
    return body.success
      ? `Trop de commentaires : réessayez dans ${String(body.data.retryAfterSeconds)} s.`
      : 'Trop de commentaires : réessayez dans un instant.'
  }
  return commentErrorMessage(caught)
}

/**
 * Champ d'un commentaire (nouveau fil, réponse, modification) : Ctrl+Entrée (Cmd+Entrée) envoie,
 * Échap annule ; `@` propose les membres du projet (flèches, Entrée ou Tab pour choisir). Les
 * mentions choisies deviennent `<@uuid>` à l'envoi.
 */
export function CommentComposer({
  selfId,
  members,
  initial,
  placeholder,
  submitLabel,
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  selfId: string | null
  members: readonly ChatMember[]
  /** Texte initial (modification) et ses mentions déjà résolues. */
  initial?: { text: string; picked: PickedMention[] }
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  /** Envoie le texte encodé ; rejette avec l'erreur de l'API (le texte est conservé). */
  onSubmit: (body: string) => Promise<void>
  onCancel?: () => void
}) {
  const [text, setText] = useState(initial?.text ?? '')
  const [caret, setCaret] = useState(initial?.text.length ?? 0)
  const [picked, setPicked] = useState<PickedMention[]>(initial?.picked ?? [])
  const [highlighted, setHighlighted] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const listId = useId()

  // Champ ouvert à la demande (nouveau commentaire, modification) : le focus y va, curseur à la fin.
  const focusOnMount = useRef(autoFocus)
  useEffect(() => {
    if (!focusOnMount.current) return
    const element = field.current
    element?.focus()
    element?.setSelectionRange(element.value.length, element.value.length)
  }, [])

  const query = mentionQueryAt(text, caret)
  const suggestions =
    query !== null && query.start !== dismissedAt
      ? mentionSuggestions(members, query.query, selfId)
      : []
  const open = suggestions.length > 0
  const active = Math.min(highlighted, Math.max(0, suggestions.length - 1))
  const encoded = encodeMentions(text.trim(), picked, members)
  const tooLong = encoded.length > COMMENT_BODY_MAX_LENGTH

  const choose = (member: ChatMember) => {
    if (query === null) return
    const next = insertMention(text, query, caret, member.name)
    setText(next.text)
    setCaret(next.caret)
    setPicked((current) => [...current, { id: member.id, name: member.name }])
    setHighlighted(0)
    requestAnimationFrame(() => {
      field.current?.focus()
      field.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  const submit = async () => {
    if (sending || encoded === '' || tooLong) return
    setSending(true)
    setError(null)
    try {
      await onSubmit(encoded)
      setText('')
      setCaret(0)
      setPicked([])
    } catch (caught) {
      setError(submitError(caught))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    // Les touches du champ ne remontent pas jusqu'aux raccourcis de la page.
    event.stopPropagation()
    if (open) {
      const choice = suggestions[active]
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setHighlighted((active + step + suggestions.length) % suggestions.length)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && choice) {
        event.preventDefault()
        choose(choice)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedAt(query?.start ?? null)
        return
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    <form
      className="relative"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      onClick={(event) => {
        // Un clic dans le champ ne sélectionne pas le fil (saut dans l'éditeur).
        event.stopPropagation()
      }}
    >
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Membres à mentionner"
          className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((member, index) => (
            <li
              key={member.id}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm',
                index === active && 'bg-accent text-accent-foreground',
              )}
              onMouseDown={(event) => {
                event.preventDefault()
                choose(member)
              }}
              onMouseEnter={() => {
                setHighlighted(index)
              }}
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: member.color }}
              />
              <span className="truncate">{member.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={field}
        value={text}
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${String(active)}` : undefined}
        aria-invalid={tooLong}
        className="field-sizing-content max-h-40 min-h-14 w-full resize-none rounded-md border border-editor-border bg-editor px-2 py-1.5 text-sm text-editor-foreground outline-none placeholder:text-editor-gutter-foreground focus-visible:ring-2 focus-visible:ring-tools/50"
        onChange={(event) => {
          setText(event.target.value)
          setCaret(event.target.selectionStart)
          setHighlighted(0)
          setError(null)
        }}
        onSelect={(event) => {
          setCaret(event.currentTarget.selectionStart)
        }}
        onKeyDown={onKeyDown}
        data-testid="comment-input"
      />
      {error !== null || tooLong ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error ?? `${String(encoded.length)} / ${String(COMMENT_BODY_MAX_LENGTH)} caractères`}
        </p>
      ) : null}
      <div className="mt-1 flex justify-end gap-1">
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="hover:bg-editor-tab-active"
            onClick={onCancel}
          >
            Annuler
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="accent"
          size="xs"
          disabled={sending || encoded === '' || tooLong}
          data-testid="comment-submit"
        >
          {sending ? <Spinner label="" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}
