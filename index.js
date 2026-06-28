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

const verifyAdmin = async (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(401).send({
      error: true,
      message: "Unauthorized access: Only Admin can do this.",
    });
  }

  next();
};

async function run() {
  try {
    await client.connect();
    const db = client.db("recipehub");
    const recipeCollection = db.collection("recipes");
    const transactionsCollection = db.collection("transactions");
    const likesCollection = db.collection("likes");
    const favoritesCollection = db.collection("favorites");
    const reportsCollection = db.collection("reports");
    const usersCollection = db.collection("user");

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

    // GET USER'S PURCHASED RECIPES
    app.get("/recipes/purchased", verifyToken, async (req, res) => {
      const userId = req.user.id;

      const purchasedRecipes = await transactionsCollection
        .aggregate([
          {
            $match: {
              userId,
              paymentStatus: "paid",
            },
          },
          {
            $addFields: {
              recipeObjectId: { $toObjectId: "$recipeId" },
            },
          },
          {
            $lookup: {
              from: "recipes",
              localField: "recipeObjectId",
              foreignField: "_id",
              as: "recipe",
            },
          },
          {
            $unwind: "$recipe",
          },
          {
            $replaceRoot: {
              newRoot: {
                $mergeObjects: ["$recipe", { paidAt: "$paidAt" }],
              },
            },
          },
        ])
        .toArray();

      res.send(purchasedRecipes);
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
      const { sessionId, type, userId } = req.body;
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

      if (type === "premium" && userId) {
        const userUpdate = await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { isPremium: true } },
        );
        if (userUpdate.matchedCount === 0) {
          return res.status(404).send({
            error: true,
            message: "Associated user account structure not found.",
          });
        }
      }
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

    // GET FAVORITE RECIPES
    app.get("/favorites", verifyToken, async (req, res) => {
      const userId = req.user.id;

      const favoriteRecipes = await favoritesCollection
        .aggregate([
          {
            $match: { userId },
          },
          {
            $addFields: {
              recipeObjectId: { $toObjectId: "$recipeId" },
            },
          },
          {
            $lookup: {
              from: "recipes",
              localField: "recipeObjectId",
              foreignField: "_id",
              as: "recipe",
            },
          },
          {
            $unwind: "$recipe",
          },
          {
            $replaceRoot: {
              newRoot: "$recipe",
            },
          },
        ])
        .toArray();

      res.send(favoriteRecipes);
    });

    // GET A FAVORITE RECIPE BY RECIPE_ID AND USER_ID
    app.get("/favorites/:id", verifyToken, async (req, res) => {
      const { id: recipeId } = req.params;
      const userId = req.user.id;

      const favorite = await favoritesCollection.findOne({
        recipeId,
        userId,
      });

      if (!favorite) {
        return res.status(404).send({
          message: "Favorite Recipe not found",
        });
      }

      res.send(favorite);
    });

    // ADD REPORT
    app.post("/reports", verifyToken, async (req, res) => {
      const report = {
        ...req.body,
        createdAt: new Date(),
      };
      const result = await reportsCollection.insertOne(report);
      res.send(result);
    });

    // GET ALL REPORTS (ADMIN ONLY)
    app.get("/reports", verifyToken, verifyAdmin, async (req, res) => {
      const reports = await reportsCollection
        .aggregate([
          {
            $lookup: {
              from: "recipes",
              let: {
                recipeId: {
                  $toObjectId: "$recipeId",
                },
              },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ["$_id", "$$recipeId"],
                    },
                  },
                },
                {
                  $project: {
                    name: 1,
                    image: 1,
                    category: 1,
                  },
                },
              ],
              as: "recipe",
            },
          },
          {
            $unwind: {
              path: "$recipe",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $sort: {
              createdAt: -1,
            },
          },
        ])
        .toArray();

      res.send(reports);
    });

    // GET USER DASHBOARD STATS
    app.get("/users/:id/stats", verifyToken, async (req, res) => {
      const userId = req.params.id;

      // Count recipes created by this user
      const totalRecipes = await recipeCollection.countDocuments({
        userId: userId,
      });

      // Count recipes favorited by this user
      const totalFavorites = await favoritesCollection.countDocuments({
        userId: userId,
      });

      // Aggregate total likes received on all recipes authored by this user
      const likesAggregation = await recipeCollection
        .aggregate([
          { $match: { userId } },
          {
            $group: {
              _id: null,
              totalLikes: { $sum: "$likeCount" },
            },
          },
        ])
        .toArray();

      const totalLikesReceived =
        likesAggregation.length > 0 ? likesAggregation[0].totalLikes : 0;

      res.status(200).send({
        totalRecipes,
        totalFavorites,
        totalLikesReceived,
      });
    });

    // GET ADMIN OVERVIEW STATS (ADMIN ONLY)
    app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments({
          role: "user",
        });

        const premiumUsers = await usersCollection.countDocuments({
          isPremium: true,
        });

        const totalRecipes = await recipeCollection.countDocuments();

        const totalReports = await reportsCollection.countDocuments();

        // Recent Users
        const recentUsers = await usersCollection
          .find({})
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();

        res.status(200).send({
          totalUsers,
          premiumUsers,
          totalRecipes,
          totalReports,
          recentUsers,
        });
      } catch (error) {
        res.status(500).send({ error: "Failed to load admin stats" });
      }
    });

    // GET ALL USERS (ADMIN ONLY)
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // TOGGLE USER STATUS
    app.patch("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
      const { id: userId } = req.params;
      const isBlocked = req.body.status !== "blocked";

      const user = await usersCollection.findOne({
        _id: new ObjectId(userId),
      });

      if (!user) {
        return res.status(404).send({
          message: "User not found.",
        });
      }

      if (user.role === "admin") {
        return res.status(403).send({
          message: "Admin accounts cannot be blocked.",
        });
      }

      await usersCollection.updateOne(
        {
          _id: new ObjectId(userId),
        },
        {
          $set: { isBlocked },
        },
      );

      res.send({
        message: "User status updated successfully.",
      });
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
