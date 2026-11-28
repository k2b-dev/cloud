### Calendar text was cut where the view meets a sticky edge

- **What happened:** In Spaces' phone week, an all-day bar that began before the first day on screen showed only a fragment of its title under the "all day" label. In the day view, the hour label nearest the top stood half under the day's sticky heading when the view opened with now in its upper third.
- **Root cause:** The bar's title sat at the bar's own start, left of the screen, inside a bar that clipped as a scroll container of its own. The day view's opening place was a pixel value derived from now and the view's height, with no regard for where the heading ends.
- **Error class:** Content placed by its own geometry without regard for a sticky edge that covers part of the view.
- **Guard:** `packages/ui/src/content/calendar-break.browser.test.ts` checks that the phone week shows all-day titles right of the label, and that the opened day and week views show no hour label cut by the head at six view heights, at 1440 and 390 px, in Chromium and WebKit.
