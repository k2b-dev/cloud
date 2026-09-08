type GqlExample = {
  title: string;
  description: string;
  code: string;
};

/**
 * Canonical copyable examples shared by the reference window and parser tests.
 * The end-user article is Markdown; this catalog remains data because Grids
 * also uses it to generate a base-aware example.
 */
export const GQL_EXAMPLES: GqlExample[] = [
  {
    title: "Open work",
    description: "A normal filtered table view.",
    code: `from table Tasks
select Name, Status, Due
where Status = 'Open'
sort Due asc
limit 50`,
  },
  {
    title: "Monthly chart source",
    description: "A grouped view that can feed a chart.",
    code: `from table Orders
group by "Ordered at" by month
aggregate sum("Line total") as revenue
sort "Ordered at" asc`,
  },
  {
    title: "Computed output",
    description: "A temporary computed column in a query result.",
    code: `from table Products
select Name, Price, formula(Price * 1.19) as gross
where Price > 0
limit 20`,
  },
  {
    title: "Readable names",
    description: "Quote labels with spaces. Keep text values in single quotes.",
    code: `from table "Line Items"
select "Item name", "Net amount"
where "Approval status" = 'Approved'
sort "Net amount" desc`,
  },
];
