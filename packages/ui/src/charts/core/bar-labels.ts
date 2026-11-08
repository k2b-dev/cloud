export const barPercent = (locale = "en") => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
