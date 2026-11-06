### An unread-count test must follow the way back to the chat list

- **What happened:** The system-chat behavior test failed because it expected the Cloud app's private unread count beside the timeline's Back link.
- **Root cause:** System chats use threaded navigation. The timeline links back to the threads page, whose Back link to the chat list already receives the private unread count. The test asserted the count on the wrong page.
- **Error class:** A behavior assertion targets the wrong navigation level
- **Guard:** The ChatWorkspace behavior test follows the timeline's Back link to the threads page and checks that its chat-list link shows and announces 40 private unread messages, without subtracting or adding system-chat unread messages.
