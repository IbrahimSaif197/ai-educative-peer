// Demo.cs — sample buggy C# for the EduPeer demonstration.
// Each method has a classic beginner mistake for the tutor to nudge you about.

using System;

class Demo
{
    static int Add(int a, int b)
    {
        return a - b;
    }

    static double Average(int[] numbers)
    {
        int total = 0;
        for (int i = 1; i < numbers.Length; i++)
        {
            total = total + numbers[i];
        }
        return total / numbers.Length;
    }

    static void Main()
    {
        string name = null;
        Console.WriteLine(Add(2, 3));
        Console.WriteLine(Average(new int[] { 10, 20, 30 }));
        Console.WriteLine(name.Length);
    }
}
