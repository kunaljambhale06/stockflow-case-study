import "dotenv/config";
import express from "express";
import productsRouter from "./routes/products.js";


const app = express();

app.use(express.json());


app.use("/api/products", productsRouter);



app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`StockFlow API running on port ${PORT}`);
});