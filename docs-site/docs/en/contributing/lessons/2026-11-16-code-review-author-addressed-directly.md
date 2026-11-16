### The author of a decided Code version was told about a notice to themselves

- **What happened:** On the preview a sole admin approved their own Code version, and the review then said "Admin gets a notification and can switch the version on." The reader was that admin.
- **Root cause:** The follow-up line under a decision always named the submitter in the third person; the self-approval work changed the hints before the decision but not this line after it.
- **Error class:** Text that names a person in the third person while the reader is that person.
- **Guard:** The review uses the server's `own` flag for the follow-up line as well; `CodeArea.render.test.tsx` renders a decided own version (`soleApproved`) and an ordinary approved one in German and English.
