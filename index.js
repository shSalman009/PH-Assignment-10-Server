const dns = require("node:dns/promises");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const cors = require("cors");
const dotenv = require("dotenv");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
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

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({
      error: true,
      message: "Unauthorized access: Missing authorization token.",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { payload } = await jwtVerify(token, JWKS);
    if (payload) {
      req.user = payload;
    }
    next();
  } catch (error) {
    return res.status(403).send({
      error: true,
      message: "Forbidden access: Invalid or expired token.",
    });
  }
};

async function run() {
  try {
    await client.connect();
    const db = client.db("recipehub");
    const recipeCollection = db.collection("recipes");
    const transactionsCollection = db.collection("transactions");
    const likesCollection = db.collection("likes");
    const favoritesCollection = db.collection("favorites");

    // CREATE A NEW RECIPE
    app.post("/recipes", verifyToken, async (req, res) => {
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
    app.get("/recipes/user/:userId", verifyToken, async (req, res) => {
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
    app.patch("/recipes/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const { ...updateData } = req.body;

      const result = await recipeCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData },
      );
      res.send(result);
    });

    // DELETE A RECIPE BY ID
    app.delete("/recipes/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const result = await recipeCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // CREATE TRANSACTION
    app.post("/transactions", verifyToken, async (req, res) => {
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

    // GET TRANSACTION BY RECIPE_ID AND USER_ID
    app.get("/transactions/:recipeId", verifyToken, async (req, res) => {
      const { recipeId } = req.params;
      const userId = req.user.id;
      const transaction = await transactionsCollection.findOne({
        recipeId,
        userId,
      });

      if (!transaction) {
        return res.status(404).send({
          message: "Transaction not found",
        });
      }

      res.send(transaction);
    });

    // RECIPE LIKE TOGGELING
    app.patch("/recipes/:id/like", verifyToken, async (req, res) => {
      const { id: recipeId } = req.params;
      const { action } = req.body;
      const userId = req.user.id;

      const query = {
        userId: userId,
        recipeId: recipeId,
      };

      const isLiked = await likesCollection.findOne(query);
      if (isLiked && action === "like") {
        return res.status(400).send({ message: "Already liked" });
      }

      if (action === "like") {
        await likesCollection.insertOne({
          ...query,
          createdAt: new Date(),
        });
      } else if (action === "unlike") {
        await likesCollection.deleteOne(query);
      }

      const totalLikes = await likesCollection.countDocuments({
        recipeId: recipeId,
      });

      const d = await recipeCollection.updateOne(
        { _id: new ObjectId(recipeId) },
        { $set: { likeCount: totalLikes } },
      );

      res.status(200).send({
        success: true,
        likeCount: totalLikes,
      });
    });

    // GET A LIKE BY RECIPE_ID AND USER_ID
    app.get("/likes/:id", verifyToken, async (req, res) => {
      const { id: recipeId } = req.params;
      const userId = req.user.id;

      const likeData = await likesCollection.findOne({
        recipeId,
        userId,
      });

      if (!likeData) {
        return res.status(404).send({
          message: "Like not found",
        });
      }

      res.send(likeData);
    });

    // FAVORITE COLLECTION TOGGLE
    app.patch("/favorites/toggle", verifyToken, async (req, res) => {
      const { recipeId } = req.body;
      const { id: userId, email } = req.user;
      console.log("id's = ", userId, recipeId);
      const existing = await favoritesCollection.findOne({ userId, recipeId });

      if (existing) {
        const response = await favoritesCollection.deleteOne({
          userId,
          recipeId,
        });
        console.log("esisting", response);

        return res.send({ favorite: false });
      }
      // Add to favorite
      const response = await favoritesCollection.insertOne({
        userId,
        userEmail: email,
        recipeId,
        createdAt: new Date(),
      });
      console.log("not existing", response);

      return res.send({ favorite: true });
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
