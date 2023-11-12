import { app } from "./index.js";

const port = process.env.PORT || "8080"
app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
});
