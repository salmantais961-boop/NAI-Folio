---
name: folio-web-tags
description: Look up a public character for NovelAI. Find the English name tag, verify the canonical Danbooru character tag, then fill in any missing appearance details.
---

# Public character tag lookup

Use this workflow when a user asks for online research or the local catalog cannot identify a public character. Keep personal OCs and their private tags in Folio. Search one character at a time.

1. **Establish the English name.** Search the supplied name together with the series or game. Check an official English character page or credits for the spelling, localized names and romanized aliases. Retry the local character index with that name. If two identities fit, ask which title or version the user means.
2. **Verify the Danbooru tag.** Search `site:danbooru.donmai.us` with the English name and series. Check the character's tag or wiki page and follow tag aliases to the current name. Preserve the exact name order, spelling and any parenthesized qualifier. A series tag, an outfit tag and a character tag serve different purposes. Use the confirmed identity once in that character's positive caption. If the index supplies it via a referenceId, Folio inserts it for you. A web result can provide a tag; only a local lookup can provide a referenceId.
3. **Look up appearance when needed.** For a specific costume or a character without a verified tag, consult official artwork or a character profile for that version. Select just the distinguishing hair, eyes, clothing or accessories that serve the request. If Danbooru has no verified match, use the verified English name and supported visual details. Keep uncertain details out.

Preserve the user's chosen outfit, style locks and negative locks. When space is tight, keep the identity tag first, followed by the requested costume or signature trait, and shorten incidental appearance tags. Cite the actual source URLs in research replies; keep citations and search commentary outside the image prompt.
