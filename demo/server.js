"use strict";

// Mimics the output of a backend server logging requests.

console.log("Listening on port", 1337);

const interval = Number(process.argv[2] ?? "1000");

const requests = [
  ["GET", "/api/users"],
  ["GET", "/api/users/42"],
  ["POST", "/api/login"],
  ["GET", "/api/products?page=2"],
  ["PUT", "/api/cart"],
  ["DELETE", "/api/cart/7"],
];

let count = 0;

setInterval(() => {
  const [method, path] = requests[count % requests.length];
  const status = count % 11 === 10 ? 500 : method === "POST" ? 201 : 200;
  const ms = Math.round(5 + Math.random() * 95);
  console.log(new Date().toISOString(), method, path, status, `${ms}ms`);
  count++;
}, interval);
