import { expect, test } from "bun:test";
import { connect } from "node:net";
import { type SmtpDataReply, smtpSink } from "./smtp-sink";

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("SMTP fixture condition timed out");
    await Bun.sleep(5);
  }
};
const sender = async (sink: ReturnType<typeof smtpSink>) => {
  const socket = connect(sink.port, "127.0.0.1");
  let output = "";
  socket.on("data", (bytes) => {
    output += bytes.toString();
  });
  await until(() => output.includes("220"));
  socket.write("EHLO test\r\nMAIL FROM:<from@example.test>\r\nRCPT TO:<to@example.test>\r\nDATA\r\n");
  await until(() => output.includes("354"));
  socket.write("Subject: Fixture\r\n\r\n..dot-stuffed\r\n.\r\n");
  return { socket, output: () => output };
};

test("default SMTP callers keep ephemeral loopback delivery and connection count", async () => {
  const sink = smtpSink();
  try {
    expect(sink.host).toBe("127.0.0.1");
    const client = await sender(sink);
    try {
      await until(() => client.output().includes("250 Message accepted"));
      expect(sink.connections).toBe(1);
      expect(sink.messages).toEqual([
        { from: "from@example.test", to: ["to@example.test"], raw: "Subject: Fixture\r\n\r\n.dot-stuffed\r\n", remoteAddress: "127.0.0.1" },
      ]);
      expect(sink.connectionLog[0]?.remoteAddress).toBe("127.0.0.1");
    } finally {
      client.socket.destroy();
    }
  } finally {
    sink.stop();
  }
});

test("DATA hold defers acceptance and its reply; release accepts once", async () => {
  let reply: SmtpDataReply | undefined;
  const sink = smtpSink({
    hostname: "127.0.0.1",
    port: 0,
    hold: (_message, pending) => {
      reply = pending;
      return true;
    },
  });
  try {
    const client = await sender(sink);
    try {
      await until(() => !!reply);
      expect(sink.messages).toHaveLength(0);
      expect(client.output()).not.toContain("250 Message accepted");
      expect(sink.connectionLog[0]?.held).toBe(true);
      reply!.release();
      reply!.release();
      await until(() => client.output().includes("250 Message accepted"));
      expect(sink.messages).toHaveLength(1);
      expect(sink.connectionLog[0]?.held).toBe(false);
    } finally {
      client.socket.destroy();
    }
  } finally {
    sink.stop();
  }
});

test("dropping held DATA leaves no accepted mail; rejection overrides still work", async () => {
  let reply: SmtpDataReply | undefined;
  const sink = smtpSink({
    hold: (_message, pending) => {
      reply = pending;
      return true;
    },
  });
  try {
    const client = await sender(sink);
    try {
      await until(() => !!reply);
      reply!.drop();
      reply!.release();
      await until(() => sink.connectionLog[0]?.closed === true);
      expect(sink.messages).toHaveLength(0);
      expect(client.output()).not.toContain("250 Message accepted");
    } finally {
      client.socket.destroy();
    }
  } finally {
    sink.stop();
  }
  const rejecting = smtpSink({ reply: (command) => (command === "MESSAGE" ? "451 Try again" : undefined) });
  try {
    const client = await sender(rejecting);
    try {
      await until(() => client.output().includes("451 Try again"));
      expect(rejecting.messages).toHaveLength(0);
    } finally {
      client.socket.destroy();
    }
  } finally {
    rejecting.stop();
  }
});
