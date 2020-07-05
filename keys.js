process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data === "\x03") {
    process.exit();
  } else {
    console.log(
      "data",
      JSON.stringify(data),
      data.length,
      data.split("").map((c) => c.charCodeAt(0).toString(16))
    );
  }
});
