/** YouTube's auto-generated "<Artist> - Topic" channels: show just the artist (also inside "A - Topic, B" lists). */
export const cleanArtist = (name: string) => name.replace(/\s+-\s+Topic(?=\s*(?:,|$))/gi, "").trim() || name;
