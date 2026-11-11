import { SentlyError } from "../core/errors.js";
import type { Attachment } from "../core/types.js";

/** Options for {@link resolveAttachments}. */
export interface ResolveAttachmentsOptions {
  /**
   * If set, attachment paths must resolve within this directory.
   * `..` segments, sibling-directory prefix matches, and symlinks whose
   * real path leaves the directory are rejected.
   *
   * Without `basePath`, `attachment.path` is trusted local I/O: the
   * process reads whatever filesystem path the caller supplies.
   */
  basePath?: string;
}

/**
 * Resolve attachment.path to in-memory Uint8Array content.
 * @throws When attachment.path is used on runtimes without node:fs/promises
 */
export async function resolveAttachments(
  attachments: Attachment[] | undefined,
  options?: ResolveAttachmentsOptions,
): Promise<Attachment[]> {
  const list = attachments ?? [];
  const resolved: Attachment[] = [];

  for (const attachment of list) {
    if (attachment.content instanceof Uint8Array) {
      resolved.push(attachment);
      continue;
    }

    if (attachment.path) {
      let fs: typeof import("node:fs/promises");
      try {
        fs = await import("node:fs/promises");
      } catch {
        throw new Error(
          "attachment.path is not supported on this runtime — use attachment.content (Uint8Array) instead",
        );
      }

      if (options?.basePath) {
        const { resolve, sep } = await import("node:path");
        const resolvedPath = resolve(attachment.path);
        const resolvedBase = resolve(options.basePath);
        const lexicalWithin =
          resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + sep);
        if (!lexicalWithin) {
          throw new SentlyError(
            `Attachment path "${resolvedPath}" escapes basePath "${resolvedBase}"`,
            "INVALID_CONFIG",
          );
        }
        const realBase = await fs.realpath(resolvedBase);
        let realFile: string;
        try {
          realFile = await fs.realpath(resolvedPath);
        } catch (cause) {
          throw new SentlyError(
            `Attachment path "${resolvedPath}" could not be resolved`,
            "INVALID_CONFIG",
            { cause },
          );
        }
        const realWithin = realFile === realBase || realFile.startsWith(realBase + sep);
        if (!realWithin) {
          throw new SentlyError(
            `Attachment path "${realFile}" escapes basePath "${realBase}"`,
            "INVALID_CONFIG",
          );
        }
      }

      const data = await fs.readFile(attachment.path);
      const { path: _path, ...rest } = attachment;
      resolved.push({ ...rest, content: new Uint8Array(data) });
      continue;
    }

    if (typeof attachment.content === "string") {
      resolved.push(attachment);
      continue;
    }

    resolved.push(attachment);
  }

  return resolved;
}
