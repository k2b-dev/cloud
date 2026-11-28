/** A `webcal://` link asks the device's calendar app to subscribe to the feed instead of downloading it once. */
export const webcalUrl = (url: string): string => url.replace(/^https?:\/\//, "webcal://");
