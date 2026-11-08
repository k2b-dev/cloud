/** JSON as a portable description stores it: no functions, dates as ISO text, missing values as null. */
export type DescriptionJson = string | number | boolean | null | DescriptionJson[] | { [key: string]: DescriptionJson };
