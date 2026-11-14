/**
 * Curated Tabler-icon catalogue for use in icon pickers.
 *
 * Each entry holds:
 *   - `id`      — the full Tabler class string ("ti ti-<name>"). Used as the
 *                 stored value in DB / config so consumers can render
 *                 directly via `<i class={value}>` without having to
 *                 prepend the family class. Render sites that DO prepend
 *                 `ti ` produce a duplicate-token (`ti ti ti-<name>`) which
 *                 the browser's classList tolerates as a no-op.
 *   - `label`   — primary display name shown in the picker.
 *   - `icon`    — same string as `id`. Kept as a separate field so the
 *                 generic `SelectInput` can pick it up via its
 *                 `option.icon` slot for the dropdown glyph.
 *   - `keywords`— synonym list used by the fuzzy-search picker. Includes
 *                 the bare icon name, common alternative names, symbol
 *                 forms ("€", "$"), and adjacent concepts ("money",
 *                 "cash" for currency icons). English only — KISS.
 *
 * Categories below are sorted top-down by the order common dashboards
 * tend to reach for; within each category entries are alphabetical.
 *
 * Size budget: ~250 entries, ~15-20 KB of inlined JSON. Bigger lists
 * would warrant a lazy-load strategy or generated data, but at this
 * size the convenience of a bundled-in module beats both.
 */

export type IconOption = {
  id: string;
  label: string;
  icon: string;
  keywords: string[];
};

const E = (id: string, label: string, keywords: string[]): IconOption => ({
  id: `ti ti-${id}`,
  label,
  icon: `ti ti-${id}`,
  keywords: [id, ...keywords],
});

export const ICON_OPTIONS: IconOption[] = [
  // ── Finance & Money ──────────────────────────────────────────────
  E("currency-euro", "Euro", ["euro", "currency", "money", "cash", "€", "eur"]),
  E("currency-dollar", "Dollar", ["dollar", "currency", "money", "cash", "$", "usd"]),
  E("currency-pound", "Pound", ["pound", "currency", "money", "£", "gbp"]),
  E("currency-yen", "Yen", ["yen", "currency", "money", "¥", "jpy"]),
  E("currency-bitcoin", "Bitcoin", ["bitcoin", "btc", "crypto", "currency"]),
  E("coin", "Coin", ["coin", "money", "cash", "currency"]),
  E("coins", "Coins", ["coins", "money", "cash", "currency", "stack"]),
  E("cash", "Cash", ["cash", "money", "bill", "banknote"]),
  E("wallet", "Wallet", ["wallet", "money", "cash", "purse", "billfold"]),
  E("credit-card", "Credit Card", ["card", "credit", "debit", "payment", "money"]),
  E("receipt", "Receipt", ["receipt", "bill", "invoice", "purchase"]),
  E("percentage", "Percent", ["percent", "percentage", "%", "discount", "rate"]),
  E("calculator", "Calculator", ["calculator", "math", "calc", "compute"]),
  E("pig-money", "Piggy Bank", ["piggy", "savings", "bank", "money"]),
  E("building-bank", "Bank", ["bank", "money", "finance", "institution"]),
  E("shopping-cart", "Shopping Cart", ["cart", "shop", "shopping", "buy", "purchase"]),
  E("shopping-bag", "Shopping Bag", ["bag", "shop", "shopping", "buy"]),
  E("trending-up", "Trending Up", ["trending", "up", "growth", "increase", "rise"]),
  E("trending-down", "Trending Down", ["trending", "down", "decrease", "fall", "drop"]),

  // ── Charts & Analytics ───────────────────────────────────────────
  E("chart-bar", "Bar Chart", ["chart", "bar", "graph", "analytics", "stats"]),
  E("chart-line", "Line Chart", ["chart", "line", "graph", "analytics", "trend"]),
  E("chart-pie", "Pie Chart", ["chart", "pie", "donut", "graph", "analytics"]),
  E("chart-donut", "Donut Chart", ["chart", "donut", "pie", "ring"]),
  E("chart-area", "Area Chart", ["chart", "area", "graph", "filled"]),
  E("chart-dots", "Scatter Chart", ["chart", "scatter", "dots", "points"]),
  E("chart-histogram", "Histogram", ["chart", "histogram", "distribution"]),
  E("chart-arcs", "Gauge", ["chart", "gauge", "arc", "meter"]),
  E("activity", "Activity", ["activity", "pulse", "heartbeat", "monitor"]),

  // ── Communication ────────────────────────────────────────────────
  E("mail", "Mail", ["mail", "email", "message", "letter", "envelope"]),
  E("mail-opened", "Mail Opened", ["mail", "email", "opened", "read"]),
  E("message", "Message", ["message", "chat", "speech", "bubble"]),
  E("message-circle", "Message Circle", ["message", "chat", "comment", "talk"]),
  E("messages", "Messages", ["messages", "chat", "conversation"]),
  E("phone", "Phone", ["phone", "call", "telephone", "mobile"]),
  E("phone-call", "Phone Call", ["phone", "call", "ringing"]),
  E("video", "Video", ["video", "camera", "film", "movie"]),
  E("microphone", "Microphone", ["microphone", "mic", "voice", "audio", "record"]),
  E("send", "Send", ["send", "submit", "deliver", "post"]),
  E("share", "Share", ["share", "send", "distribute", "social"]),
  E("rss", "RSS", ["rss", "feed", "subscribe"]),
  E("at", "At", ["at", "mention", "@", "email"]),

  // ── Notifications & Status ───────────────────────────────────────
  E("bell", "Bell", ["bell", "notification", "alert", "alarm"]),
  E("bell-ringing", "Bell Ringing", ["bell", "notification", "ringing", "alert"]),
  E("alarm", "Alarm", ["alarm", "alert", "warning", "siren"]),
  E("alert-triangle", "Warning", ["alert", "warning", "caution", "danger"]),
  E("alert-circle", "Alert", ["alert", "warning", "info", "exclamation"]),
  E("info-circle", "Info", ["info", "information", "help", "tip"]),
  E("circle-check", "Check Circle", ["check", "ok", "done", "success", "approved"]),
  E("circle-x", "Cancel", ["cancel", "close", "x", "remove", "rejected"]),
  E("check", "Check", ["check", "tick", "ok", "done", "yes"]),
  E("x", "Close", ["close", "x", "cancel", "dismiss", "remove"]),

  // ── Documents & Writing ──────────────────────────────────────────
  E("notebook", "Notebook", ["notebook", "journal", "diary", "writing"]),
  E("book", "Book", ["book", "read", "library", "novel"]),
  E("note", "Note", ["note", "memo", "annotation"]),
  E("notes", "Notes", ["notes", "memo", "list", "writing"]),
  E("file-text", "Document", ["document", "file", "text", "doc"]),
  E("file-code", "Code File", ["file", "code", "source", "script"]),
  E("file-spreadsheet", "Spreadsheet", ["spreadsheet", "excel", "sheet", "csv", "table"]),
  E("file", "File", ["file", "document"]),
  E("files", "Files", ["files", "documents", "multiple"]),
  E("clipboard", "Clipboard", ["clipboard", "paste", "copy"]),
  E("clipboard-list", "Clipboard List", ["clipboard", "list", "todo", "checklist"]),
  E("list-check", "Checklist", ["checklist", "todo", "tasks", "list"]),
  E("bookmark", "Bookmark", ["bookmark", "save", "favorite", "marker"]),
  E("pencil", "Pencil", ["pencil", "edit", "write", "compose"]),
  E("edit", "Edit", ["edit", "modify", "change", "pencil"]),
  E("quote", "Quote", ["quote", "citation", "blockquote"]),
  E("tag", "Tag", ["tag", "label", "category", "marker"]),
  E("tags", "Tags", ["tags", "labels", "categories"]),

  // ── Office & Work ────────────────────────────────────────────────
  E("briefcase", "Briefcase", ["briefcase", "work", "business", "job"]),
  E("building", "Building", ["building", "office", "company", "enterprise"]),
  E("building-store", "Store", ["store", "shop", "retail", "market"]),
  E("building-skyscraper", "Skyscraper", ["skyscraper", "building", "tower", "city"]),
  E("folder", "Folder", ["folder", "directory", "files"]),
  E("folder-open", "Folder Open", ["folder", "open", "directory"]),
  E("archive", "Archive", ["archive", "storage", "box"]),
  E("paperclip", "Paperclip", ["paperclip", "attach", "attachment"]),
  E("scissors", "Scissors", ["scissors", "cut", "trim"]),
  E("stamp", "Stamp", ["stamp", "approved", "seal"]),
  E("printer", "Printer", ["printer", "print"]),
  E("presentation", "Presentation", ["presentation", "slides", "deck"]),
  E("calendar", "Calendar", ["calendar", "date", "schedule", "agenda"]),
  E("calendar-event", "Event", ["event", "calendar", "meeting", "appointment"]),
  E("calendar-stats", "Calendar Stats", ["calendar", "stats", "schedule"]),

  // ── Time ────────────────────────────────────────────────────────
  E("clock", "Clock", ["clock", "time", "hour", "minute"]),
  E("clock-hour-3", "Clock 3", ["clock", "time", "afternoon"]),
  E("hourglass", "Hourglass", ["hourglass", "time", "wait", "duration"]),
  E("alarm-clock", "Alarm Clock", ["alarm", "clock", "wake", "time"]),
  E("history", "History", ["history", "past", "log", "back"]),
  E("watch", "Watch", ["watch", "time", "wristwatch"]),
  E("stopwatch", "Stopwatch", ["stopwatch", "timer", "time", "race"]),

  // ── Places & Travel ──────────────────────────────────────────────
  E("home", "Home", ["home", "house", "main"]),
  E("home-2", "Home 2", ["home", "house"]),
  E("map-pin", "Map Pin", ["pin", "map", "location", "place", "marker"]),
  E("map", "Map", ["map", "location", "geography"]),
  E("map-2", "Map 2", ["map", "location"]),
  E("world", "World", ["world", "earth", "global", "international"]),
  E("globe", "Globe", ["globe", "world", "earth", "global"]),
  E("compass", "Compass", ["compass", "direction", "navigation"]),
  E("car", "Car", ["car", "auto", "vehicle", "drive"]),
  E("truck", "Truck", ["truck", "delivery", "shipping", "lorry"]),
  E("bus", "Bus", ["bus", "transport", "public"]),
  E("train", "Train", ["train", "rail", "transport"]),
  E("plane", "Plane", ["plane", "flight", "airplane", "aviation"]),
  E("rocket", "Rocket", ["rocket", "launch", "space", "fast", "boost"]),
  E("ship", "Ship", ["ship", "boat", "vessel", "sea"]),
  E("sailboat", "Sailboat", ["sailboat", "boat", "sail"]),
  E("bike", "Bike", ["bike", "bicycle", "cycle"]),
  E("walk", "Walk", ["walk", "person", "pedestrian"]),
  E("tent", "Tent", ["tent", "camping", "outdoors"]),
  E("plant", "Plant", ["plant", "nature", "green"]),

  // ── Action Verbs ─────────────────────────────────────────────────
  E("plus", "Plus", ["plus", "add", "new", "create", "+"]),
  E("minus", "Minus", ["minus", "subtract", "remove", "-"]),
  E("trash", "Trash", ["trash", "delete", "remove", "bin", "garbage"]),
  E("copy", "Copy", ["copy", "duplicate", "clone"]),
  E("device-floppy", "Save", ["save", "floppy", "disk", "store"]),
  E("refresh", "Refresh", ["refresh", "reload", "sync", "update"]),
  E("rotate", "Rotate", ["rotate", "spin", "turn"]),
  E("download", "Download", ["download", "save", "import"]),
  E("upload", "Upload", ["upload", "import", "send"]),
  E("search", "Search", ["search", "find", "magnify", "look"]),
  E("filter", "Filter", ["filter", "narrow", "refine"]),
  E("settings", "Settings", ["settings", "preferences", "config", "gear", "cog"]),
  E("adjustments", "Adjustments", ["adjustments", "settings", "tune", "sliders"]),
  E("link", "Link", ["link", "url", "chain", "hyperlink"]),
  E("external-link", "External Link", ["external", "link", "open", "new"]),
  E("login", "Login", ["login", "signin", "enter"]),
  E("logout", "Logout", ["logout", "signout", "exit"]),
  E("dots", "Dots", ["dots", "more", "menu", "ellipsis"]),
  E("dots-vertical", "Dots Vertical", ["dots", "vertical", "more", "menu"]),
  E("menu-2", "Menu", ["menu", "hamburger", "nav"]),

  // ── Arrows & Navigation ──────────────────────────────────────────
  E("arrow-up", "Arrow Up", ["arrow", "up"]),
  E("arrow-down", "Arrow Down", ["arrow", "down"]),
  E("arrow-left", "Arrow Left", ["arrow", "left", "back"]),
  E("arrow-right", "Arrow Right", ["arrow", "right", "forward", "next"]),
  E("chevron-up", "Chevron Up", ["chevron", "up", "collapse"]),
  E("chevron-down", "Chevron Down", ["chevron", "down", "expand", "dropdown"]),
  E("chevron-left", "Chevron Left", ["chevron", "left", "back"]),
  E("chevron-right", "Chevron Right", ["chevron", "right", "forward"]),
  E("arrow-up-right", "Arrow Up Right", ["arrow", "diagonal", "external"]),
  E("arrows-shuffle", "Shuffle", ["shuffle", "random", "arrows"]),
  E("arrows-sort", "Sort", ["sort", "arrange", "order"]),
  E("arrows-up-down", "Up Down", ["arrows", "vertical", "swap"]),

  // ── Security ─────────────────────────────────────────────────────
  E("lock", "Lock", ["lock", "secure", "private", "locked"]),
  E("lock-open", "Unlock", ["unlock", "open", "unlocked"]),
  E("shield", "Shield", ["shield", "protect", "guard", "secure"]),
  E("shield-check", "Shield Check", ["shield", "secure", "verified"]),
  E("eye", "Eye", ["eye", "see", "view", "show", "visible"]),
  E("eye-off", "Eye Off", ["hide", "invisible", "hidden", "private"]),
  E("key", "Key", ["key", "password", "secret", "auth"]),
  E("ban", "Ban", ["ban", "forbidden", "block", "no", "denied"]),
  E("fingerprint", "Fingerprint", ["fingerprint", "biometric", "security", "id"]),

  // ── Layout & UI ──────────────────────────────────────────────────
  E("layout", "Layout", ["layout", "design", "arrangement"]),
  E("layout-grid", "Grid", ["grid", "layout", "tiles"]),
  E("layout-dashboard", "Dashboard", ["dashboard", "layout", "panels", "tiles"]),
  E("layout-rows", "Rows", ["rows", "layout", "horizontal"]),
  E("layout-columns", "Columns", ["columns", "layout", "vertical"]),
  E("layout-list", "List Layout", ["list", "layout"]),
  E("list", "List", ["list", "items"]),
  E("list-numbers", "Ordered List", ["list", "ordered", "numbers", "1234"]),
  E("table", "Table", ["table", "rows", "columns", "grid", "spreadsheet"]),
  E("columns", "Columns", ["columns", "vertical"]),
  E("pin", "Pin", ["pin", "fix", "stick"]),
  E("pinned", "Pinned", ["pinned", "fixed", "saved"]),
  E("focus-2", "Focus", ["focus", "target", "center"]),

  // ── People & Users ───────────────────────────────────────────────
  E("user", "User", ["user", "person", "profile", "account"]),
  E("users", "Users", ["users", "people", "group", "team"]),
  E("user-plus", "Add User", ["user", "add", "invite", "join"]),
  E("user-minus", "Remove User", ["user", "remove", "leave"]),
  E("user-check", "User Verified", ["user", "verified", "approved"]),
  E("user-circle", "User Circle", ["user", "profile", "avatar"]),
  E("friends", "Friends", ["friends", "people", "social"]),
  E("id", "ID", ["id", "card", "identification"]),
  E("id-badge", "ID Badge", ["badge", "id", "lanyard", "pass"]),
  E("mood-smile", "Smile", ["smile", "happy", "mood", "emoji"]),
  E("mood-happy", "Happy", ["happy", "mood", "smile", "emoji"]),

  // ── Media ────────────────────────────────────────────────────────
  E("photo", "Photo", ["photo", "image", "picture"]),
  E("camera", "Camera", ["camera", "photo", "capture", "snap"]),
  E("video", "Video", ["video", "movie", "film"]),
  E("music", "Music", ["music", "song", "audio", "tune"]),
  E("headphones", "Headphones", ["headphones", "audio", "music", "listen"]),
  E("player-play", "Play", ["play", "start", "media"]),
  E("player-pause", "Pause", ["pause", "stop", "media"]),
  E("player-stop", "Stop", ["stop", "halt", "media"]),
  E("volume", "Volume", ["volume", "sound", "audio"]),
  E("volume-off", "Mute", ["mute", "silent", "volume", "off"]),
  E("device-tv", "TV", ["tv", "television", "screen"]),
  E("podcast", "Podcast", ["podcast", "audio", "show"]),

  // ── Tech & Dev ───────────────────────────────────────────────────
  E("code", "Code", ["code", "programming", "source", "dev"]),
  E("braces", "Braces", ["braces", "code", "json", "{}"]),
  E("brackets", "Brackets", ["brackets", "code", "[]"]),
  E("terminal", "Terminal", ["terminal", "console", "shell", "cli"]),
  E("command", "Command", ["command", "key", "cmd"]),
  E("git-branch", "Git Branch", ["git", "branch", "fork"]),
  E("git-commit", "Git Commit", ["git", "commit"]),
  E("git-merge", "Git Merge", ["git", "merge", "combine"]),
  E("git-pull-request", "Pull Request", ["git", "pr", "pull", "merge"]),
  E("brand-github", "GitHub", ["github", "git", "code", "repo"]),
  E("brand-gitlab", "GitLab", ["gitlab", "git", "code", "repo"]),
  E("bug", "Bug", ["bug", "error", "issue", "defect"]),
  E("database", "Database", ["database", "db", "storage", "data"]),
  E("server", "Server", ["server", "host", "machine"]),
  E("cloud", "Cloud", ["cloud", "storage", "online", "sync"]),
  E("cloud-upload", "Cloud Upload", ["cloud", "upload", "sync"]),
  E("cloud-download", "Cloud Download", ["cloud", "download", "sync"]),
  E("api", "API", ["api", "endpoint", "service"]),
  E("cpu", "CPU", ["cpu", "processor", "chip", "compute"]),
  E("device-laptop", "Laptop", ["laptop", "computer", "device"]),
  E("device-desktop", "Desktop", ["desktop", "computer", "monitor"]),
  E("device-mobile", "Mobile", ["mobile", "phone", "device"]),
  E("device-tablet", "Tablet", ["tablet", "ipad", "device"]),
  E("plug", "Plug", ["plug", "connect", "power", "outlet"]),
  E("robot", "Robot", ["robot", "bot", "ai", "automation"]),
  E("browser", "Browser", ["browser", "web", "www"]),
  E("www", "WWW", ["www", "web", "internet", "url"]),
  E("network", "Network", ["network", "connection", "graph"]),
  E("wifi", "WiFi", ["wifi", "wireless", "internet"]),
  E("bluetooth", "Bluetooth", ["bluetooth", "wireless"]),

  // ── Symbols & Awards ─────────────────────────────────────────────
  E("star", "Star", ["star", "favorite", "rating"]),
  E("star-filled", "Star Filled", ["star", "filled", "favorite"]),
  E("heart", "Heart", ["heart", "love", "favorite", "like"]),
  E("heart-filled", "Heart Filled", ["heart", "filled", "love"]),
  E("diamond", "Diamond", ["diamond", "gem", "premium"]),
  E("crown", "Crown", ["crown", "king", "vip", "premium"]),
  E("trophy", "Trophy", ["trophy", "award", "winner", "champion"]),
  E("award", "Award", ["award", "medal", "achievement"]),
  E("medal", "Medal", ["medal", "award", "achievement"]),
  E("ribbon", "Ribbon", ["ribbon", "badge", "award"]),
  E("flag", "Flag", ["flag", "marker", "country", "milestone"]),
  E("target", "Target", ["target", "goal", "aim", "bullseye"]),
  E("sparkles", "Sparkles", ["sparkles", "magic", "shiny", "new"]),
  E("flame", "Flame", ["flame", "fire", "hot", "trending"]),
  E("bolt", "Bolt", ["bolt", "lightning", "electric", "fast", "energy"]),
  E("infinity", "Infinity", ["infinity", "endless", "∞"]),
  E("circle", "Circle", ["circle", "round", "dot"]),
  E("square", "Square", ["square", "box"]),
  E("triangle", "Triangle", ["triangle"]),

  // ── Tools & Crafts ───────────────────────────────────────────────
  E("tool", "Tool", ["tool", "wrench", "fix", "repair"]),
  E("tools", "Tools", ["tools", "build", "fix"]),
  E("hammer", "Hammer", ["hammer", "build", "tool"]),
  E("ruler", "Ruler", ["ruler", "measure"]),
  E("magnet", "Magnet", ["magnet", "attract"]),
  E("paint", "Paint", ["paint", "color", "art", "brush"]),
  E("palette", "Palette", ["palette", "color", "art"]),
  E("brush", "Brush", ["brush", "paint", "art"]),
  E("droplet", "Droplet", ["droplet", "drop", "water", "color"]),
  E("typography", "Typography", ["typography", "text", "font"]),
  E("color-swatch", "Color Swatch", ["color", "swatch", "palette"]),
  E("photo-edit", "Photo Edit", ["photo", "edit", "image", "filter"]),

  // ── Nature & Weather ─────────────────────────────────────────────
  E("sun", "Sun", ["sun", "light", "day", "bright"]),
  E("moon", "Moon", ["moon", "night", "dark"]),
  E("cloud-rain", "Rain", ["rain", "weather", "cloud", "wet"]),
  E("snowflake", "Snow", ["snow", "snowflake", "winter", "cold"]),
  E("flame-2", "Fire", ["fire", "flame", "hot"]),
  E("rainbow", "Rainbow", ["rainbow", "colors"]),
  E("tornado", "Tornado", ["tornado", "storm", "wind"]),
  E("mountain", "Mountain", ["mountain", "peak", "alps"]),
  E("flower", "Flower", ["flower", "bloom", "rose"]),
  E("leaf", "Leaf", ["leaf", "nature", "green", "eco"]),
  E("tree", "Tree", ["tree", "nature", "forest"]),
  E("seeding", "Seedling", ["seedling", "plant", "grow", "sprout"]),
  E("mushroom", "Mushroom", ["mushroom", "fungi"]),
  E("cactus", "Cactus", ["cactus", "desert", "plant"]),
  E("wind", "Wind", ["wind", "breeze"]),
  E("temperature", "Temperature", ["temperature", "thermometer", "heat", "weather"]),

  // ── Animals ──────────────────────────────────────────────────────
  E("cat", "Cat", ["cat", "kitty", "pet", "animal"]),
  E("dog", "Dog", ["dog", "puppy", "pet", "animal"]),
  E("fish", "Fish", ["fish", "animal", "aquarium"]),
  E("bug", "Bug", ["bug", "insect", "issue"]),
  E("butterfly", "Butterfly", ["butterfly", "insect"]),
  E("feather", "Feather", ["feather", "bird", "light"]),
  E("paw", "Paw", ["paw", "animal", "pet"]),
  E("deer", "Deer", ["deer", "animal", "wildlife"]),
  E("horse", "Horse", ["horse", "animal"]),
  E("pig", "Pig", ["pig", "animal", "farm"]),
  E("spider", "Spider", ["spider", "arachnid", "halloween"]),
  E("bat", "Bat", ["bat", "animal", "halloween"]),

  // ── Food & Drink ─────────────────────────────────────────────────
  E("apple", "Apple", ["apple", "fruit", "food"]),
  E("cherry", "Cherry", ["cherry", "fruit", "food"]),
  E("lemon", "Lemon", ["lemon", "fruit", "citrus"]),
  E("pizza", "Pizza", ["pizza", "food"]),
  E("cake", "Cake", ["cake", "dessert", "birthday"]),
  E("cookie", "Cookie", ["cookie", "dessert", "snack"]),
  E("candy", "Candy", ["candy", "sweet", "treat"]),
  E("ice-cream", "Ice Cream", ["icecream", "dessert", "frozen"]),
  E("coffee", "Coffee", ["coffee", "cup", "drink", "caffeine"]),
  E("mug", "Mug", ["mug", "cup", "drink", "beverage"]),
  E("glass", "Glass", ["glass", "drink", "wine"]),
  E("bottle", "Bottle", ["bottle", "drink"]),

  // ── Misc & Fun ───────────────────────────────────────────────────
  E("puzzle", "Puzzle", ["puzzle", "piece", "jigsaw"]),
  E("dice", "Dice", ["dice", "random", "game"]),
  E("ghost", "Ghost", ["ghost", "halloween", "spooky"]),
  E("alien", "Alien", ["alien", "ufo", "space"]),
  E("atom", "Atom", ["atom", "science", "physics"]),
  E("dna", "DNA", ["dna", "biology", "genetics"]),
  E("microscope", "Microscope", ["microscope", "science", "lab"]),
  E("telescope", "Telescope", ["telescope", "astronomy", "space"]),
  E("planet", "Planet", ["planet", "space", "world"]),
  E("meteor", "Meteor", ["meteor", "space", "comet"]),
  E("gift", "Gift", ["gift", "present", "box"]),
  E("balloon", "Balloon", ["balloon", "party", "celebration"]),
  E("confetti", "Confetti", ["confetti", "party", "celebration"]),
  E("lamp", "Lamp", ["lamp", "light", "lighting"]),
  E("bulb", "Idea", ["bulb", "idea", "light", "innovation", "lightbulb"]),
  E("brain", "Brain", ["brain", "mind", "think"]),
  E("anchor", "Anchor", ["anchor", "ship", "stable"]),
  E("wand", "Wand", ["wand", "magic", "spell"]),
  E("sword", "Sword", ["sword", "weapon", "fight"]),
  E("shopping-cart-off", "Empty Cart", ["cart", "empty", "off"]),
];

export type IconOptionLegacy = IconOption;

export const icons = {
  ICON_OPTIONS,
  options: ICON_OPTIONS,
} as const;
