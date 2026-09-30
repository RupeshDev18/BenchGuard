/**
 * mock-api.js
 *
 * Lightweight mock Spring Boot REST API for testing and demoing the pipeline.
 * Simulates microservice behavior with realistic response times and headers.
 */

const http = require("http");
const url = require("url");

const PORT = process.env.PORT || 8080;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const products = [
  { id: 101, name: "Wireless Mechanical Keyboard", category: "electronics", price: 129.99, inStock: true },
  { id: 102, name: "Ultra-wide 4K Monitor", category: "electronics", price: 499.00, inStock: true },
  { id: 103, name: "Ergonomic Mesh Chair", category: "furniture", price: 289.50, inStock: true },
  { id: 104, name: "Noise Cancelling Headphones", category: "electronics", price: 199.95, inStock: false },
  { id: 105, name: "USB-C Dual Docking Station", category: "electronics", price: 89.00, inStock: true }
];

const orders = [
  { orderId: "ORD-99824", customerId: "CUST-4029", totalAmount: 259.98, status: "CONFIRMED", createdAt: new Date().toISOString() },
  { orderId: "ORD-99825", customerId: "CUST-1044", totalAmount: 89.00, status: "SHIPPED", createdAt: new Date().toISOString() }
];

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // Simulate realistic microservice response latency (30ms to 70ms)
  const delay = Math.floor(Math.random() * 40) + 30;
  await sleep(delay);

  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-Service-Name", "Spring-Boot-Core-API");
  res.setHeader("X-Response-Time-Ms", String(delay));

  // Distributed Tracing: Inspect & propagate W3C traceparent and baggage
  const traceparent = req.headers["traceparent"];
  const baggage = req.headers["baggage"];
  const xTraceId = req.headers["x-trace-id"];

  if (traceparent) {
    res.setHeader("traceresponse", traceparent);
    const traceMatch = String(traceparent).match(/^00-([0-9a-f]{32})-/i);
    if (traceMatch) {
      res.setHeader("X-Trace-Id", traceMatch[1]);
    }
  } else if (xTraceId) {
    res.setHeader("X-Trace-Id", xTraceId);
  }
  if (baggage) {
    res.setHeader("X-Echoed-Baggage", String(baggage));
  }

  // Health endpoint
  if (method === "GET" && pathname === "/api/v1/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "UP", timestamp: new Date().toISOString() }));
  }

  // List Products
  if (method === "GET" && pathname === "/api/v1/products") {
    res.writeHead(200);
    return res.end(JSON.stringify(products));
  }

  // Create Product
  if (method === "POST" && pathname === "/api/v1/products") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
      const newProduct = {
        id: Math.floor(Math.random() * 1000) + 200,
        name: parsed.name || "Sample Product",
        category: parsed.category || "general",
        price: parsed.price || 99.99,
        inStock: true
      };
      res.writeHead(201);
      res.end(JSON.stringify(newProduct));
    });
    return;
  }

  // Get Product by ID
  if (method === "GET" && pathname.startsWith("/api/v1/products/")) {
    const id = parseInt(pathname.split("/").pop(), 10);
    const item = products.find((p) => p.id === id) || products[0];
    res.writeHead(200);
    return res.end(JSON.stringify(item));
  }

  // Get Orders
  if (method === "GET" && pathname === "/api/v1/orders") {
    res.writeHead(200);
    return res.end(JSON.stringify(orders));
  }

  // Place Order
  if (method === "POST" && pathname === "/api/v1/orders") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) {}
      const newOrder = {
        orderId: `ORD-${Math.floor(Math.random() * 90000) + 10000}`,
        customerId: parsed.customerId || "CUST-9999",
        totalAmount: 189.50,
        status: "CONFIRMED",
        createdAt: new Date().toISOString()
      };
      res.writeHead(201);
      res.end(JSON.stringify(newOrder));
    });
    return;
  }

  // Order Status
  if (method === "GET" && pathname.includes("/orders/") && pathname.endsWith("/status")) {
    const parts = pathname.split("/");
    const orderId = parts[parts.length - 2] || "ORD-99824";
    res.writeHead(200);
    return res.end(JSON.stringify({
      orderId,
      status: "CONFIRMED",
      trackingNumber: "TRK-2026-X9",
      estimatedDelivery: "2026-09-18"
    }));
  }

  // Fallback 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Endpoint Not Found", path: pathname }));
});

server.listen(PORT, () => {
  console.log(`[mock-api] Spring Boot mock server listening on http://localhost:${PORT}`);
  console.log(`[mock-api] Ready to receive k6 load requests.`);
});

module.exports = server;
