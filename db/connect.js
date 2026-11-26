//Must follow CRUD Create Read Update and Destroy
const mongoose = require('mongoose');
mongoose.set('strictQuery', false);//This prevent all the errors
mongoose.set('useFindAndModify', false);  // To avoid deprecation warning for findOneAndUpdate() and related methods
mongoose.set('useCreateIndex', true); // only needed in older versions (pre v6)
//This is for the internet
const connectDB  = (url) => {//This is the method we use to connect to the mongodb database
    
    return mongoose.connect(url,{//This setup is not compulsory if using version 6,but its just used to remove deprecation errors
            useNewUrlParser: true,  // Enables the new URL parser
            useUnifiedTopology: true,  // Enables the new server discovery and monitoring engine
            // One shared pool per process; fail fast instead of hanging requests when Mongo is unreachable.
            poolSize: Number(process.env.MONGO_POOL_SIZE) || 20,
            serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_MS) || 10000,
            socketTimeoutMS: 45000,
        })
}

module.exports = connectDB;