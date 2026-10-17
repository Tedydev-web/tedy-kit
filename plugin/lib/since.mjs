export function sinceTime(since) {
  const time = Date.parse(since);
  if (Number.isNaN(time)) throw new Error(`--since is not a date: ${since}`);
  return time;
}

export const notBefore = (time, since) => Date.parse(time) >= sinceTime(since);
