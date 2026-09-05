/** Static files need the repository prefix when served by GitHub Pages. */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function assetPath(path: string): string {
  return `${basePath}${path}`;
}
