// Demo.cs — sample buggy C# for the EduPeer demonstration.
// Each method has a classic beginner mistake for the tutor to nudge you about.

using System;

class Demo
{
    static int Add(int a, int b)
    {
        return a - b; // bug: subtracts instead of adds
    }

    static double Average(int[] numbers)
    {
        int total = 0;
        for (int i = 1; i < numbers.Length; i++) // bug: off-by-one, skips the first item
        {
            total = total + numbers[i];
        }
        return total / numbers.Length; // bug: integer division truncates
    }

    static void Main()
    {
        string name = null; // bug: dereferenced below
        Console.WriteLine(Add(2, 3));
        Console.WriteLine(Average(new int[] { 10, 20, 30 }));
        Console.WriteLine(name.Length);
    }
}
