const dns = require("node:dns/promises");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("recipehub");
    const recipeCollection = db.collection("recipes");
    const transactionsCollection = db.collection("transactions");

    // CREATE A NEW RECIPE
    app.post("/recipes", async (req, res) => {
      const recipe = {
        ...req.body,
        createdAt: new Date(),
      };
      const result = await recipeCollection.insertOne(recipe);
      res.send(result);
    });

    // GET ALL RECIPES
    app.get("/recipes", async (req, res) => {
      const { search, category } = req.query;
      let query = {};

      if (search) {
        query.name = {
          $regex: search,
          $options: "i",
        };
      }
      if (category) {
        query.category = {
          $regex: category,
          $options: "i",
        };
      }
      const recipes = await recipeCollection.find(query).toArray();
      res.send(recipes);
    });

    // GET RECIPES BY USER ID
    app.get("/recipes/user/:userId", async (req, res) => {
      const { userId } = req.params;
      const recipes = await recipeCollection
        .find({ userId })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(recipes);
    });

    // GET A SINGLE RECIPE BY ID
    app.get("/recipes/:id", async (req, res) => {
      const { id } = req.params;
      const recipe = await recipeCollection.findOne({ _id: new ObjectId(id) });
      res.send(recipe);
    });

    // UPDATE A RECIPE BY ID
    app.patch("/recipes/:id", async (req, res) => {
      const { id } = req.params;
      const { ...updateData } = req.body;

      const result = await recipeCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData },
      );
      res.send(result);
    });

    // DELETE A RECIPE BY ID
    app.delete("/recipes/:id", async (req, res) => {
      const { id } = req.params;
      const result = await recipeCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // CREATE TRANSACTION
    app.post("/transactions", async (req, res) => {
      const { sessionId } = req.body;
      const isExist = await transactionsCollection.findOne({ sessionId });

      if (isExist) {
        return res.status(200).send({
          message: "Transaction already processed and saved.",
          insertedId: isExist._id,
        });
      }

      const transaction = {
        ...req.body,
        paidAt: new Date(),
      };
      const result = await transactionsCollection.insertOne(transaction);
      res.status(201).send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
