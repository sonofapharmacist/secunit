const MULTI_PERCENT_ENCODED_RUN_RE = /(?:%[0-9A-Fa-f]{2}){2,}/g
const HTML_ENTITY_RE = /&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d+)|#([xX])([0-9A-Fa-f]+));/g
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF\u2060]/g

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
}

interface NormalizeContentContext {
  title?: string
  url?: string
}

interface NormalizeContentResult {
  normalized: string
  transforms_fired: string[]
}

export function normalizeExternalContent(
  text: string,
  context?: NormalizeContentContext,
): NormalizeContentResult {
  try {
    if (typeof text !== "string" || text.length === 0) {
      return { normalized: "", transforms_fired: [] }
    }

    void context

    const transformsFired: string[] = []
    let normalized = text

    const urlDecoded = normalized.replace(MULTI_PERCENT_ENCODED_RUN_RE, (run: string): string => {
      // Isolated %XX sequences are preserved by design; only multi-run matches reach this decoder.
      try {
        return decodeURIComponent(run)
      } catch {
        return run
      }
    })
    if (urlDecoded !== normalized) {
      transformsFired.push("url-decode")
      normalized = urlDecoded
    }

    const htmlDecoded = normalized.replace(
      HTML_ENTITY_RE,
      (
        entity: string,
        namedEntity?: string,
        decimalEntity?: string,
        _hexPrefix?: string,
        hexEntity?: string,
      ): string => {
        try {
          if (namedEntity !== undefined) {
            return NAMED_HTML_ENTITIES[namedEntity] ?? entity
          }
          if (decimalEntity !== undefined) {
            return String.fromCharCode(parseInt(decimalEntity, 10))
          }
          if (hexEntity !== undefined) {
            return String.fromCharCode(parseInt(hexEntity, 16))
          }
          return entity
        } catch {
          return entity
        }
      },
    )
    if (htmlDecoded !== normalized) {
      transformsFired.push("html-entities")
      normalized = htmlDecoded
    }

    const zeroWidthStripped = normalized.replace(ZERO_WIDTH_RE, "")
    if (zeroWidthStripped !== normalized) {
      transformsFired.push("zero-width")
      normalized = zeroWidthStripped
    }

    return { normalized, transforms_fired: transformsFired }
  } catch {
    return { normalized: text, transforms_fired: [] }
  }
}
