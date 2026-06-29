export function formatCommunityDate(date: Date, timezone: string) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: timezone,
  }).format(date);
  const month = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: timezone,
  }).format(date);
  const day = Number(
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      timeZone: timezone,
    }).format(date),
  );

  return `${weekday}, ${month} ${ordinal(day)}`;
}

export function isWeekend(date: Date, timezone: string) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: timezone,
  }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

export function ordinal(day: number) {
  const mod10 = day % 10;
  const mod100 = day % 100;
  if (mod10 === 1 && mod100 !== 11) return `${day}st`;
  if (mod10 === 2 && mod100 !== 12) return `${day}nd`;
  if (mod10 === 3 && mod100 !== 13) return `${day}rd`;
  return `${day}th`;
}
