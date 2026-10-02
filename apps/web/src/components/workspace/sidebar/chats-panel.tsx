'use client'

import { CHAT_MESSAGE_MAX_LENGTH, chatRateLimitedErrorSchema } from '@kaxolax/contracts'
import { Avatar, AvatarFallback, AvatarImage, Button, cn, initialsOf, Spinner } from '@kaxolax/ui'
import { MessagesSquareIcon, SendHorizontalIcon } from 'lucide-react'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api, ApiError, type ProjectTree } from '@/lib/api'
import {
  type ChatMember,
  chatErrorMessage,
  chatMember,
  chatMembers,
  dayLabel,
  displaySegments,
  encodeMentions,
  groupMessages,
  insertMention,
  mentionQueryAt,
  mentions,
  mentionSuggestions,
  type PickedMention,
  timeLabel,
} from '@/lib/chat'
import type { ProjectChat } from '../use-project-chat'

/** Distance au haut de la liste (px) qui déclenche le chargement des messages plus anciens. */
const LOAD_OLDER_THRESHOLD_PX = 48
/** Distance au bas de la liste (px) en deçà de laquelle un nouveau message fait défiler. */
const STICK_TO_BOTTOM_PX = 64
/** Le compteur de caractères s'affiche au-delà de cette part de la longueur maximale. */
const COUNTER_FROM = 0.9

function sendError(caught: unknown): string {
  if (caught instanceof ApiError && caught.status === 429) {
    const body = chatRateLimitedErrorSchema.safeParse(caught.body)
    return body.success
      ? `Trop de messages : réessayez dans ${String(body.data.retryAfterSeconds)} s.`
      : 'Trop de messages : réessayez dans un instant.'
  }
  return chatErrorMessage(caught)
}

/**
 * Onglet Chats de la sidebar : chat du projet entre collaborateurs (les conversations avec
 * l'assistant s'y ajouteront à l'étape 3). Messages regroupés par jour et par auteur, affichés en
 * texte brut (aucun HTML interprété), mentions `@Nom` et références `fichier.tex:42` cliquables
 * vers un fichier existant du projet ; anciens messages chargés au défilement vers le haut.
 */
export function ChatsPanel({
  projectId,
  tree,
  selfId,
  chat,
  membersVersion,
  onOpenLocation,
}: {
  projectId: string
  tree: ProjectTree | null
  selfId: string | null
  chat: ProjectChat
  /** Incrémenté à chaque événement de membre : la liste des membres (mentions) est relue. */
  membersVersion: number
  /** Ouvre un document du projet à une ligne. */
  onOpenLocation?: (path: string, line: number) => void
}) {
  const [members, setMembers] = useState<ChatMember[]>([])
  useEffect(() => {
    const state = { active: true }
    api.members(projectId).then(
      (response) => {
        if (state.active) setMembers(chatMembers(response.members))
      },
      () => undefined,
    )
    return () => {
      state.active = false
    }
  }, [projectId, membersVersion])
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members])

  const { messages, hasMore, loadingOlder, loadOlder } = chat
  const days = useMemo(() => groupMessages(messages), [messages])

  // Défilement : position conservée quand des messages plus anciens s'ajoutent en haut, collé en
  // bas quand un nouveau message arrive alors qu'on était déjà en bas.
  const list = useRef<HTMLDivElement | null>(null)
  const nearBottom = useRef(true)
  const prepend = useRef<{ height: number; top: number } | null>(null)
  const onScroll = useCallback(() => {
    const element = list.current
    if (!element) return
    nearBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX
    if (element.scrollTop < LOAD_OLDER_THRESHOLD_PX && hasMore && !loadingOlder) {
      prepend.current = { height: element.scrollHeight, top: element.scrollTop }
      void loadOlder()
    }
  }, [hasMore, loadingOlder, loadOlder])
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const anchor = prepend.current
    if (anchor !== null && element.scrollHeight !== anchor.height) {
      element.scrollTop = element.scrollHeight - anchor.height + anchor.top
      prepend.current = null
    } else if (nearBottom.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [messages])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-panel">
      <div
        ref={list}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        role="log"
        aria-live="polite"
        aria-label="Messages du projet"
        aria-busy={chat.status === 'loading' || loadingOlder}
      >
        {chat.status === 'loading' ? (
          <div className="flex h-full items-center justify-center text-sidebar-muted-foreground">
            <Spinner />
          </div>
        ) : chat.status === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-sidebar-muted-foreground">
            <p role="alert">Impossible de charger le chat : {chat.error}</p>
            <Button size="sm" variant="outline" onClick={chat.retry}>
              Réessayer
            </Button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sidebar-muted-foreground">
            <MessagesSquareIcon className="size-6" />
            <p className="text-sm">Aucun message pour l'instant. Écrivez le premier !</p>
          </div>
        ) : (
          <>
            {hasMore ? (
              <div className="flex justify-center py-1 text-sidebar-muted-foreground">
                {loadingOlder ? (
                  <Spinner />
                ) : (
                  <button
                    type="button"
                    className="text-xs underline-offset-2 hover:underline"
                    onClick={() => {
                      const element = list.current
                      if (element)
                        prepend.current = { height: element.scrollHeight, top: element.scrollTop }
                      void loadOlder()
                    }}
                  >
                    Messages précédents
                  </button>
                )}
              </div>
            ) : null}
            {days.map((day) => (
              <section key={day.key} aria-label={dayLabel(day.key)}>
                <div className="sticky top-0 z-10 flex justify-center py-1">
                  <span className="rounded-full bg-sidebar-accent px-2 py-0.5 text-[0.6875rem] text-sidebar-muted-foreground first-letter:uppercase">
                    {dayLabel(day.key)}
                  </span>
                </div>
                {day.groups.map((group) => {
                  const first = group.messages[0]
                  if (!first) return null
                  const author =
                    memberById.get(group.authorId) ??
                    chatMember(first.author.id, first.author.fullName, first.author.avatarUrl)
                  return (
                    <article key={first.id} className="flex gap-2 py-1.5">
                      <Avatar size="sm" className="mt-0.5">
                        {author.avatarUrl ? <AvatarImage src={author.avatarUrl} alt="" /> : null}
                        <AvatarFallback
                          className="text-white"
                          style={{ backgroundColor: author.color }}
                        >
                          {initialsOf(author.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <header className="flex items-baseline gap-2">
                          <span className="truncate text-sm font-medium">
                            {group.authorId === selfId ? `${author.name} (vous)` : author.name}
                          </span>
                          <time
                            dateTime={first.createdAt}
                            className="shrink-0 text-[0.6875rem] text-sidebar-muted-foreground"
                          >
                            {timeLabel(first.createdAt)}
                          </time>
                        </header>
                        {group.messages.map((message) => (
                          <p
                            key={message.id}
                            title={timeLabel(message.createdAt)}
                            className={cn(
                              'text-sm break-words whitespace-pre-wrap',
                              selfId !== null &&
                                mentions(message.body, selfId) &&
                                'rounded-sm bg-sidebar-primary/10 px-1',
                            )}
                            data-testid="chat-message"
                          >
                            {displaySegments(message.body, tree, memberById).map(
                              (segment, index) => {
                                if (segment.kind === 'text')
                                  return <span key={index}>{segment.text}</span>
                                if (segment.kind === 'mention')
                                  return (
                                    <span
                                      key={index}
                                      className={cn(
                                        'rounded-sm px-0.5 font-medium text-sidebar-primary',
                                        segment.userId === selfId && 'bg-sidebar-primary/15',
                                      )}
                                    >
                                      @{segment.member?.name ?? 'ancien membre'}
                                    </span>
                                  )
                                return (
                                  <button
                                    key={index}
                                    type="button"
                                    className="font-mono text-[0.8125rem] text-sidebar-primary underline underline-offset-2 hover:no-underline"
                                    title={`Ouvrir ${segment.document.path} à la ligne ${String(segment.line)}`}
                                    onClick={() =>
                                      onOpenLocation?.(segment.document.path, segment.line)
                                    }
                                  >
                                    {segment.text}
                                  </button>
                                )
                              },
                            )}
                          </p>
                        ))}
                      </div>
                    </article>
                  )
                })}
              </section>
            ))}
          </>
        )}
      </div>
      <ChatComposer
        selfId={selfId}
        members={members}
        disabled={chat.status !== 'ready'}
        onSend={async (body) => {
          nearBottom.current = true
          await chat.send(body)
        }}
      />
    </div>
  )
}

/**
 * Champ de saisie : Entrée envoie, Maj+Entrée va à la ligne ; `@` propose les membres du projet
 * (flèches, Entrée ou Tab pour choisir, Échap pour fermer). Les mentions choisies deviennent
 * `<@uuid>` à l'envoi.
 */
function ChatComposer({
  selfId,
  members,
  disabled,
  onSend,
}: {
  selfId: string | null
  members: readonly ChatMember[]
  disabled: boolean
  onSend: (body: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [picked, setPicked] = useState<PickedMention[]>([])
  const [highlighted, setHighlighted] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const listId = useId()

  const query = mentionQueryAt(text, caret)
  const suggestions =
    query !== null && query.start !== dismissedAt
      ? mentionSuggestions(members, query.query, selfId)
      : []
  const open = suggestions.length > 0
  const active = Math.min(highlighted, Math.max(0, suggestions.length - 1))

  const encoded = encodeMentions(text.trim(), picked, members)
  const tooLong = encoded.length > CHAT_MESSAGE_MAX_LENGTH
  const showCounter = encoded.length > CHAT_MESSAGE_MAX_LENGTH * COUNTER_FROM

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
    if (sending || disabled || encoded === '' || tooLong) return
    setSending(true)
    setError(null)
    try {
      await onSend(encoded)
      setText('')
      setCaret(0)
      setPicked([])
    } catch (caught) {
      setError(sendError(caught))
    } finally {
      setSending(false)
      field.current?.focus()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <form
      className="relative shrink-0 border-t border-sidebar-border p-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Membres à mentionner"
          className="absolute inset-x-2 bottom-full mb-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
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
                // Garde le focus dans le champ.
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
      <div className="flex items-end gap-1">
        <textarea
          ref={field}
          value={text}
          rows={1}
          disabled={disabled}
          placeholder="Écrire un message… (@ pour mentionner)"
          aria-label="Message"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${String(active)}` : undefined}
          aria-invalid={tooLong}
          className="field-sizing-content max-h-32 min-h-8 flex-1 resize-none rounded-md border border-sidebar-border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-sidebar-muted-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50 disabled:opacity-50"
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
          data-testid="chat-input"
        />
        <Button
          type="submit"
          size="icon-sm"
          variant="ghost"
          aria-label="Envoyer"
          disabled={disabled || sending || encoded === '' || tooLong}
          className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {sending ? <Spinner /> : <SendHorizontalIcon />}
        </Button>
      </div>
      {showCounter || error !== null ? (
        <div className="mt-1 flex gap-2 text-xs">
          {error !== null ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {showCounter ? (
            <p
              className={cn(
                'ml-auto tabular-nums',
                tooLong ? 'text-destructive' : 'text-sidebar-muted-foreground',
              )}
            >
              {encoded.length} / {CHAT_MESSAGE_MAX_LENGTH}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}
